# Platform, interfaces, presentation and distribution: current audit

## Scope and evidence status

Primary: `/root/audit_platform`. Independent challenger: `/root/audit_runtime`.
Source: `1c3f1b383ad3eb02052f8240c9f6749134210f4c` in
`/home/vince/Projects/canlang`. This is a planning-only review. No product build,
test, install, provider request, service, Git mutation or implementation was run
by this reviewer. The recent overdue implementation's executed checks remain
evidence of their recorded subjects, not qualification of every platform path.

The scoped tracked inventory contains 679 paths: Cloudflare 366, Interfaces 66,
UI 49, Testkit 29, Stdlib 5, and 164 root/CI/script/test/example/gitlink inputs.
All scoped regular files were read for structural classification: 678 text
files, 13,405,782 bytes, 397 program files and 6,874 top-level declaration lines.
Sixty-six JSON documents were decoded. `packages/stdlib/tsconfig.json` is JSONC,
so ordinary JSON decoding does not establish an error in that file. The `draft`
gitlink is independent source ownership and belongs to the coordinator's corpus
inventory. Structural reading/indexing is **not** substantive review of every
function, embedded program, test assertion or established product journey.

| Dimension | Status at this source |
| --- | --- |
| Responsibility coverage | All paths structurally classified; mixed duties below mapped. Substantive duty review remains partial, especially the app-specific source profiles and large test matrices. |
| Established source workflows | Traced compiler/artifact preparation, serving admission, HTTP/MCP convergence, bound dispatch phase, browser input identity and release/install ownership. Full provider, browser, root-authority and recovery journeys are not independently requalified here. |
| Independent challenge | Actual challenge changed the proposed invocation split and confirmed UI helper ownership, TS host fit and the CI variant gap. Remaining equivalence gates are explicit below. |
| Exact allocation | Every existing scoped path is retained at its current owner by default; two exact successor leaves are selected below. Unproved deeper splits and conditional executor retirement are not executable relocations. |

The current source therefore supports a useful task list and selected extraction
boundaries, but not an assertion that all 6,874 indexed units received a complete
correctness audit. Unreviewed duties must remain visible in the global matrix.

## Intended contracts and slices

Requirements come from `docs/specification/REQUIREMENTS.md` (source-owned business
behavior, common canonical operations for browser and MCP, the full presentation
vocabulary and generated input contracts), `DESIGN.md` sections 6–9 and 13, the
artifact/interface contracts, and current user instructions preserving authority
while replacing app-specific execution paths. Code comments naming historical
lanes and future joins are not independent owner decisions.

| Slice | Defining responsibility and state | Current defining source families | Dependencies |
| --- | --- | --- | --- |
| P-ARTIFACT | Validate and prepare a checked artifact, import closure and source maps; one terminal preparation job | Cloudflare `preparation/`, `src/preparation/`, artifact/modules/assembly-verification/sourcemap, deploy module import/map/bundle helpers | Compiler artifact and producer distribution contracts; P-DISTRIBUTION packages the selected output |
| P-SERVING | Bind source metadata and host resources, route HTTP/MCP to canonical State admission and safe projection | Cloudflare worker/runtime composition, Interfaces HTTP/MCP/OAuth/uploads, Stdlib export assembly | State owns admission/commit/replay; Identity owns authentication/grants; Values owns codecs; Files owns receiving custody |
| P-PRESENTATION | Canonical controls/forms/collections, page navigation and browser binding lifetime | UI source/browser/assets plus Interfaces presentation, input-choice, preference and fragment adapters | Source declarations and canonical writable/readable descriptors; no browser authority grant |
| P-DELIVERY | Compose canonical Work/source/provider lifecycles without introducing another claim or receipt authority | Cloudflare bound dispatch/resource/queue/receipt adapters and invocation dispatch/fanout sections | Work owns durable states, State owns fences/admission, Services owns provider behavior and Files owns custody |
| P-AUTHORING-HOST | Execute compiled examples and saved generation controls using their actual tool/source identities | Testkit, Cloudflare generation controls, source/example adapters, integration/e2e/example fixtures | Compiler and native dev owner; P-ARTIFACT assembled modules; P-SERVING canonical invocation |
| P-DISTRIBUTION | Build/discover/pack/install/activate the complete producer closure and its installed command identities | Root manifests/config/scripts/CI; Cloudflare release/upgrade and deployment publication; package distribution metadata | Every workspace distribution owner and the native compiler/dev/preparation binaries |

These are responsibility slices, not six new packages or processes. A mixed
function has one defining owner; other slices are callers, not competing writers.

## Source workflow traces

1. **Preparation:** `cli/platform.ts` dispatches the actual host commands to
   `src/preparation/host.ts`. The selected TS or native path consumes the same
   artifact and host facts. The native route resolves and verifies the selected
   executable, drives the versioned framed protocol, handles one job and its
   ordered host requests, then publishes prepared outputs through the publication
   session. `preparation/src/job.rs` owns the retained job state machine;
   `artifact.rs`, `modules.rs`, `plan.rs`, `render.rs`, `compatibility.rs`,
   `review.rs` and `release.rs` own its substantive transforms. Node remains the
   owner of SDK/bundler/process integration and actual publication. A Rust
   `Prepared` terminal is not permission to perform a deploy without the host's
   existing confirmation and compatibility gates.
2. **Installed artifact closure:** `deploy/producer-files.ts` resolves actual
   package exports; `deploy/package-assets.ts` checks producer manifest file sets,
   byte lengths, digests and directory confinement before exposing bytes.
   `deploy/bundle.ts` stages exact producer/module/resource closures and explicitly
   pins runtime leaf names. `runtime/modules.ts` rewrites supported imports into
   private versioned assemblies and registers assembly verification. The latter
   is not a generic `import()` permission or a synthetic source claim.
3. **Serving:** `worker/main.ts` verifies staged deployment/resources and constructs
   real joins. `worker/assembly.ts::buildInvoker` rejects descriptor-less serving,
   selects owner storage from the admitted identity, and dispatches mutations and
   reads through `invokeMutationCanonical` / `invokeReadCanonical`. HTTP validates
   route/body identity, capped bodies, CSRF, source form binding and closed typed
   inputs. MCP uses grant authentication, negotiated Streamable HTTP, generated
   tool/schema discovery and the same canonical invoker. Neither transport may
   grant identity from business inputs or replace State policy with UI visibility.
4. **Source and dispatch decisions:** explicit `when_at=source` is checked by the
   compiler and installed as the exact guard evaluation mode. The existing opaque
   declaration includes the mode, original source/rule/owner/node/typed slots,
   binding/target and intent correspondence. The native dispatch preclaim proves
   that physical source before retaining its true staged decision. Current owner
   identity, host authority, source/File lifetime, supersession and claim fences
   still run. Omitted/current mode re-evaluates the predicate. The old privileged
   Invoice overdue executor is absent at this source. This is a real shared
   mechanism already implemented, not a new translation task in this plan.
5. **Browser controls:** `forms.ts` and `controls.ts` share input name/ID/error
   outlet, datetime and boolean-presence helpers. Generated fields and server
   projection preserve readonly/closed input distinctions. `browser/bootstrap.ts`
   owns mount registration, rebind/dispose, poll regions, form drafts, dialogs,
   input choices and browser client lifetime. `collections.ts` owns list/table/
   gallery/board presentation and bound query controls. Their rendering cannot
   create a new source permission or make a denied action admissible.
6. **Examples and test subjects:** Testkit converts compiler-generated example
   steps into injected canonical dispatch and actual observation hooks; e2e's
   artifact loader explicitly distinguishes compiled and handbuilt identities.
   A handbuilt or injected fixture can test its real adapter, but cannot certify
   compiler lowering. Unsupported/setup-failed examples remain gaps. Large
   preparation fixtures also embed historical generated programs; their contents
   are compatibility data, not proof that every embedded function is active.
7. **CI and installed releases:** current CI builds actual workspace/catalog,
   compiler and native preparation prerequisites, runs package/integration/runtime
   tests and browser journeys, then checks installed declarations/Worker assets.
   `pack-release.mjs` discovers every workspace owner, checks the complete internal
   runtime closure and packs private dependencies too. Release/install workflows
   preserve the actual native binary selectors, notices, hashes and platform
   qualification. Historical claims that only five packages are packed or that CI
   never builds the compiler are superseded. No current public/installed release
   was executed by this audit.

## Mixed files and complete remainder ownership

The ordinary source flag is 1,000 lines; encoded/generated fixture flags use a
separate data classification. This prompts concern inspection, not arbitrary
splitting. Full retained functions stay intact, including their callbacks and
private state. The coordinator's per-path inventory supplies every leaf.

| Source selectors | Defining duty | Selected disposition |
| --- | --- | --- |
| `runtime/invoke.ts`: `InvokeResult`, `message`, `AssembledFrame`, `PAREN_FRAME_RE`, `BARE_FRAME_RE`, `urlToPath`, `ParsedFrame`, `parseStackFrames`, `matchGeneratedModule`, `buildModuleMatchers`, `findAssembledFrame`, `findRemappedFrame`, `collectSources`, `mapThrownError` | Pure callable error/stack/source-map projection; no live authority state | Move complete cohort to `runtime/invocation-errors.ts`; retain public `invoke.ts` re-exports and import internal helpers from their one owner. |
| `invokeWith`, callable resolution and `invokeCallable*` | Verified import-before-execution, source carrier binding and callable execution | Retain in `invoke.ts`: `invokeWith` reads `rowPolicyAssemblies`, source-correspondence predicates and `verifyCheckedAssembly`; the apparent first-file seam is not independent. |
| `invoke.ts` policy transcription, producer interfaces/loaders, descriptor caches, model/CRUD candidate and source/membership/reference/query/framework binders | Original source metadata and actual installed producer definitions | Retain all private maps, import shell and helper/error/type declarations in `invoke.ts`; do not publish a claimable context DTO to make extraction easy. |
| `runScenarioExecution`, `runScenarioSeam`, mutation entrypoints, staged overlays, containment navigation, source/callback/identity-removal/committed/due/retained handler drivers | Canonical host execution and one State/Work transaction boundary | Retain complete functions and nested closures in `invoke.ts`. Generalizing further named app profiles requires original-source permission/order/race equivalence first. |
| Receipt read, page read/query/presentation, File consumption and preferences helpers in `invoke.ts` | Current authorized observation and projection | Retain in `invoke.ts`; receipt extraction presently depends on canonical descriptor and private Judgment/source loaders. No independent observer authority is introduced. |
| Dispatch interfaces/results/checks, `nativeEmailPreclaims`, `bindNativeEmailDispatchGuards`, `driveDispatchIntent*`, `runRecoverySweep` | Genuine preclaim issuance/consumption and Work host execution | Retain their transitive cohort together in `invoke.ts`. A broad `dispatch-driver.ts` move was rejected during independent challenge. |
| Fanout constants, row controls, producer loaders, trigger/claim/record/navigation/scheduler/progress/cancel operations plus `createCanonicalFanoutBody` | State-fenced durable fanout host/body join | Retain in `invoke.ts` until a complete private producer/body/caller handoff exists; avoid a new facade that splits real authority. |
| `deploy/bundle.ts`: producer bundling/cache, runtime/vendor inventories, browser assets, module import/map rewrites, build/output paths and publication inputs | One closed staged deployment graph | Retain file and all private module/global units; selected runtime extraction updates its explicit leaf inventory coherently. No rename to a build facade is selected merely because the file uses Node. |
| `generation/controls.ts`: persisted control/capture/unit/attempt indexes, compiler/Git adapters, leases/saved validation and operation routing | One source/tool-bound saved-generation lifecycle | Retain; a store/capture/router split needs actual shared write/lease closure mapping first. No second state machine or process selected. |
| `preparation/host.ts` command envelopes, backend selection, native lifetime/integrity/protocol, publication and TS fallback | Host integration over the actual native preparation owner | Retain whole functions and host/native distinctions. Binary manifest, protocol and fixed-stage contracts stay with current defining owners. |
| `worker/main.ts`, `worker/assembly.ts`, resource and bound dispatch adapters | Platform composition, app/owner/resource selection and serving closures | Retain TS owners and public package exports. Source-driven provider differences must be conserved before any consolidation. |
| `interfaces/src/mcp/schemas.ts` | Artifact/input checking used by both MCP and HTTP, plus tool-schema projection | Retain at current path for this allocation. Neutralizing the directory name is optional; merging it into a provider or creating a second business schema is not selected. |
| `ui/src/forms.ts`: `pointerToFieldName`, `unescapeSegment`, `formatDatetimeLocal`, `assertFieldPath`, `fieldName`, `fieldInputName`, `fieldInputId`, `fieldErrorOutletId`, `hidden`, `nativeBooleanPresence`, `NATIVE_BOOLEAN_PRESENCE_PREFIX`, `FIELD_PATH_RE`, `DATETIME_RE`, `TIME_RE` | Shared form/control field identities and transport representation | Move complete cohort to `ui/src/internal/field-binding.ts`. Import existing `internal/draft-values.ts::isValidDate`, `escape.ts::escapeAttr` and Contracts types; copy none. Keep all existing public forms exports stable. |
| Remaining `forms.ts` and all `controls.ts` factories, generated input/date-fold projection, bindings and outcome rendering | Form and explicit-control presentation | Retain owning files; both import field bindings from the new neutral leaf, removing the actual forms↔controls cycle. No policy or control factory logic moves with helper extraction. |
| `collections.ts`, `browser/bootstrap.ts`, browser poll/export/print, navigation/shell/settings/messages | Coherent collection, mount, UI and browser lifetime responsibilities | Retain current files and source-driven render/authorization boundaries. No arbitrary one-file-per-control split. |
| `preparation/tests/modules.rs` (134 tests, a 2,877,926-byte longest line), other preparation Rust tests and raw/map/progress fixtures | Real algorithm harness plus embedded historical program/data corpus | Retain fixture bytes and test functions. Bulk source text is not an active compiler/runtime owner; no regeneration/deletion selected. |
| Root/package/CI/scripts and all other scoped manifests, configuration, tests, fixtures, assets, examples and support files | Existing defining responsibility by package and artifact kind | Retain exact current leaf unless the coordinator's canonical retirement/allocation explicitly supersedes it. Untracked dependencies and build caches are not audited source. |

These tables own globals/imports/types/support and nested function duties through
the named complete cohort or retained remainder. They do not falsely claim every
remaining app-specific path is semantically reviewed simply because it has an owner.

## Findings and required corrections

| ID | Classification and exact observation | Requirement/consequence | Correction and evidence limit |
| --- | --- | --- | --- |
| P-F01 | Verification coverage gap: `native-invoice-overdue.integration.test.ts` selects renamed/live/source-false/metadata/persisted-origin controls through `CAN_OVERDUE_*` environment variables; current default `test:all` / CI never enumerates those modes | The shared source/live guard and original-origin contract needs continuing meaningful integration coverage. Prior manual runs are valid at their own revision, but default test discovery is not their execution. | Parameterize these real cases in the existing allowed integration file, or enumerate them in its owning existing runner. Preserve the single production subject and reuse common setup; no new test framework. Source inspection only in this audit. |
| P-F02 | Architecture debt: `forms.ts` imports control factories while `controls.ts` imports eight public field/transport helpers back from forms | A renderer factory should not be the defining owner of another renderer's primitive field identity; current cycle adds coupling, not demonstrated authorization failure | Move exactly the field-binding cohort above; retain form exports and all writable/readonly, boolean presence, error-pointer, escaping and temporal behavior. No runtime bug claimed merely from an ESM cycle. |
| P-F03 | Conditional obsolete implementation: `runtime/executors.ts` owns an interim mirrored dispatch row producer and decorators; no active production import or package export was found | Work is the genuine dispatch row producer; a second historical row builder should not become a new serving owner | Candidate retirement only after final installed-file/discovery and module-closure check. Matches elsewhere are comments and embedded historical preparation programs, which must remain as compatibility data. This audit has not proved arbitrary external deep-import absence. |
| P-F04 | Architecture debt and incomplete equivalence: `invoke.ts` combines source-definition/private execution state, transport, page observation and durable Work/fanout host joins | Size alone does not establish an independent authority boundary. Naively splitting its first callable or dispatch sections breaks actual private source/preclaim identity | Select only the read-only error cohort now. Retain unproved private cohorts; require exact issuer/consumer/global closure and ordinary/retained/due/false/race equivalence before deeper movement. |
| P-F05 | Potential consolidation, not yet an established defect: Cloudflare `readDispatchExecutionRow` and its field readers mirror Work's dispatch table reader | Work should own canonical row semantics, but acceptance/error/projection differences can be intentional host compatibility | Runtime primary must compare exact required/optional fields, historical partial rows and refusal behavior before selecting `readDispatchRow` reuse. No mechanically ready replacement or new target leaf follows from textual duplication. |

The language primary owns the independently found `when_at` grammar/prototype
documentation mismatch. This record does not duplicate its correction or silently
reinterpret current `when` semantics. No new platform correctness exploit was
established by this bounded source review.

For P-F05, independent runtime inspection found a concrete non-equivalence:
Work's reader additionally checks source-guard/File-origin pairing and the
original mode/intent, queue origins, private Mail pins and generation control
correlation. The CF helper projects lifecycle fields without those full checks.
Replacing it is therefore a possible correctness correction with compatibility
and first-error consequences, not a pure relocation. Downstream genuine Work
commands may already reject malformed rows; no exploit is inferred from the gap.

## Language and package fit

Retain TypeScript for Worker `fetch`/D1/DO/Queues composition, JS module/source-map
integration, HTTP/MCP SDK adapters, browser DOM/control factories and Testkit's
execution of generated JS functions. The strongest supported alternative is Rust
with a WASM or host protocol boundary. It can centralize selected pure transforms,
but translating these duties would add Fetch/DOM/SDK/callback/codec/lifetime joins
and move established producer identities; no measurement or source finding here
justifies that cost. This is a technical recommendation, not an unrestricted
proof that TS is always best or an owner policy forbidding other languages.

Retain the actual Rust `can-preparation` producer and its Node host adapter. Its
ordered single-job protocol and lossless module/input transformations already
exist and have independent integration roots. The strongest alternative is the
existing prepared-TS backend, which removes a subprocess/toolchain but would
retire real native behavior and recreate protocol/provenance/compatibility work.
No new port, process or blanket conversion is selected. Closed native Work/Values
kernels remain with their runtime primary; a native kernel is not authority to
move Worker storage or provider lifecycles into that kernel.

Retain current semantic packages and their exports. Packing private packages is
now an explicit release-artifact function; `private: true` is not evidence that
the installed closure is absent. Consolidating Cloudflare, Interfaces or UI into
one package might simplify manifests, but changes actual public imports,
distribution metadata, browser assets, native catalog discovery and installed
dependency identity without removing their authority boundaries.

Package roots are not universally Worker-safe. In particular Files' real root
exports its Node filesystem-backed store; current State and deployment select
the appropriate `ports`, `finalize`, bridge and durable-storage subpaths. The
filesystem implementation is a real host owner, not automatically a test double.
Preserve those exact import/export and staged-closure distinctions when changing
package layout; no present Worker leak was established here.

## Coherent task packets and exclusive writers

| Packet | M / C / V scope | Exact physical writers and joins | Dependencies and readiness |
| --- | --- | --- | --- |
| P-T01 | **C:** turn the env-only overdue modes into normal integration cases; no production change. **V:** source/live-after-payment, renamed owner, >200 ledger, genuine due refusal and header/mode downgrade cases against real compiler/State/Work. | Existing `packages/cloudflare/src/runtime/native-invoice-overdue.integration.test.ts`; if runner selection is used, Cloudflare `package.json` and root runner/CI writer owns that handoff. | Ready specification; preserve no-unit-test policy. No audit-authorized execution. |
| P-T02 | **M:** extract field-binding cohort; update relative imports and preserve public re-exports. **V:** existing real form/control/browser input and readonly/error/temporal cases. | `packages/ui/src/forms.ts`, `controls.ts`, new `internal/field-binding.ts`; UI `index.ts` only if public re-export path needs adjustment. Interfaces consumers read unchanged UI exports. | Ready exact extraction; no new schema or permission producer. One UI writer. |
| P-T03 | **M:** extract read-only error/remap cohort into `runtime/invocation-errors.ts`; `invoke.ts` imports it and preserves public symbols. **V:** existing source-map/callable-error and installed Worker/module-closure checks. | Both runtime files and exclusive integration writer for `deploy/bundle.ts::PINNED_RUNTIME_FILES`; frozen preparation module fixtures are retained, not regenerated by default. | Exact cohort selected; closure/build/install verification remains unperformed. Source/authority globals stay in `invoke.ts`. |
| P-T04 | **M:** remove interim executors only if final consumer/payload check confirms retirement. **C:** none inferred. **V:** real canonical Work row staging and installed worker closure. | `runtime/executors.ts`, stale `invoke.ts` comments, actual pack/staging declarations if they select the leaf; no edits to historical embedded program bytes merely to erase name matches. | Gated on last-consumer/public-installed assessment; no executable deletion before that gate. |
| P-T05 | **C/M:** compare canonical Work row reader versus the CF host projection; select one defining codec only after equivalence. **V:** actual stored legacy/current rows, null/control fields and error/refusal classes. | Runtime primary owns `packages/work/src/kernel/tables.ts`; CF integration writer owns `invoke.ts::readDispatchExecutionRow` and helpers. | Investigation gate P-F05; not an approved port or automatic replacement. |
| P-T06 | **M:** retain other mapped files and serving/distribution boundaries; absorb selected extraction joins coherently. **V:** package exports, native binary selector, producer catalog, private runtime leaf and installed/browser closure checks at their actual scope. | Coordinator exclusively owns shared manifests, `.github/workflows/ci.yml`, `turbo.json`, `scripts/*`, pinned runtime/vendor inventories and shared fixtures. Each semantic package retains its files. | Unchanged duties need no implementation task. Unreviewed authority/workflow duties remain review gates, not ready instructions to rewrite them. |

Parallel planning lanes are UI (P-T02), test coverage (P-T01), and readonly runtime
error extraction (P-T03). The shared integration writer serializes manifests,
explicit staging lists and installed fixtures. P-T04/P-T05 do not block those
independent packets. Source/preclaim/Work-body state remains a single writer
cohort in `invoke.ts`; no agent receives different hunks of that file concurrently.
No implementation lane is launched by this audit.

## Independent challenge and revised conclusion

The runtime challenger inspected the actual issuer/consumer relationship of
`nativeEmailPreclaims`, native source definitions and guarded dispatch. A proposed
broad dispatch extraction was rejected: it would require exposing private
handles or introducing a dependency cycle without a proven boundary. Further
primary inspection found the same issue in `invokeWith`, which mutates
`rowPolicyAssemblies`; broad callable extraction was withdrawn too. Only the
read-only error projection cohort remains selected. Receipt/fanout extractions
are recorded as incomplete ideas, not desired-tree leaves.

The challenger accepted moving, rather than copying, the UI field identity
helpers with existing forms exports and policy consumers preserved. TS Worker/
DOM/SDK retention is supported at this actual host boundary; native-kernel
placement is not generalized to all runtime duties. The executor retirement
retains its explicit staging/installed and embedded-history caveats. The CI
environment-only variant gap remains a source-supported finding; manual feature
checks do not satisfy default discovery.

This reviewer independently challenged the language primary's compiler/dev split:
keep one actual native session/generation selector; subordinate SDK worker results
must never select a generation; preserve source-context construction/caches and
actual/fresh IR correspondence; preserve installed compiler/dev/LSP/completion
selectors. Existing custom LSP zero-dependency setup is a concrete current
constraint, not a new user mandate or global proof of superiority. Python syntax
tooling remains live through its README caller and cannot be retired on Rust
semantic rejection alone.

## Remaining evidence limits

No audit-time runtime measurements or installed qualification were performed.
All 679 paths have structural dispositions, but full semantic review of the
remaining app-specific source adapters, complete UI vocabulary, all root/queue/
fanout/provider lifecycles and every frozen fixture program is incomplete.
The current 56 diagnostics and prior focused checks do not close those duties.
The exact selected task outputs can be planned without calling that missing
workflow/challenge dimension complete. Only the independent, fully named packets
above are ready for a later implementation instruction.
