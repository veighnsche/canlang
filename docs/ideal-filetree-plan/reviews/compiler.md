# Compiler, authoring, values and shared producer contracts

Planning review for `/Users/vince/Projects/canlang`, pinned parent source
`350163ad661e61b667809a5f78b608c23812a5f0`, compared with the reconciled
`8249342707d3280e88e39e8c911b7e457828f31f` checkpoint. Draft authority remains
`2d673127e03e8b8bc369a7a34858165c034df131`. This record authorizes no
implementation, service operation, test/build, Git mutation or installation.

## Coverage and evidence boundaries

[The path ledger](compiler-coverage.json) accounts for all 394 pinned paths in
`compiler`, `editors`, `packages/contracts`, `packages/values`, `packages/stdlib`
and `tools`: 118 changed paths inspected (93 text and 25 PNG) and 276 unchanged
paths reusing the earlier full-source responsibility review at identical bytes.
Text inspection includes content/diffs, JSON shapes, symbol/field and test-family
decoding; it does not imply that every checker branch has been exhaustively
proved correct. Oversized changed files were inspected by distinct symbol and
responsibility families, with selected new joins traced through real consumers.

Representative visual inspection covered `themes-512.png`,
`file-icon-offset.png` and `side-by-side-1254.png`; all other added PNGs were
classified through signature/dimensions and their named preview roles. Source
SVG geometry and the icon generator were read. Preview/package-verification
records are historical evidence: their reported build/package/install passes
were not performed again. The records themselves distinguish packaged bytes
from live icon display, which remains unverified. Preserve those records and
the approved raster rather than treating them as ignored build products.

The concurrent dirty `packages/contracts/src/artifact.ts` overlay was read
separately. It adds `ArtifactServerInit`, optional server `init` payload and
child-create input documentation. It is outside the pinned source checkpoint;
its apparent join with already committed Rust emission cannot be promoted to
committed contract evidence until reconciled by its merge handler.

| Slice | Source responsibilities | Workflow tracing | Independent challenge | Target allocation |
| --- | --- | --- | --- | --- |
| Language checking and lowering | All owned changed paths structurally inspected; unchanged prior evidence reused; one parser/resolver/typer/effects context retained | Source → ordered analysis → IR → JS/artifact traced; provider nominal typing, hooks, nullable/query facts and examples have case-family evidence; no new runtime success inferred | Platform challenger confirmed form and decimal findings; runtime policy/clock joins independently cross-read | Existing private pass leaves retained; richer descriptor and form duties explicitly added below |
| Artifact/shared producer contracts | Every changed contract inspected, including canonical execution/provider/reference families | Rust descriptors → loader/intake and policy consumer traced; actual metadata/callable join defect remains | Policy mismatch independently confirmed with runtime reviewer | Neutral contracts owner retained; state execution family receives an exact defining leaf |
| CLI/docs/policy/migrations | New sources and their case families inspected; docs/schema/source links read | Checked reference model → fixed-argv JSON stdin renderer; migration desired-schema checks → runtime predecessor authority; command IO failures traced | Platform challenger accepted ownership separation with shared checked-program/source identity constraints | New existing leaves retained; proposed private docs/CLI leaves below |
| LSP/editor/Python authoring | Added client/provider/test/icon paths inspected; unchanged TextMate/Python evidence reused | LSP full-document lifecycle → custom client → VS Code providers/restart traced; Python remains current CI/README syntax caller | Platform challenger confirmed restart race and current client policy constraint | One server/client lifecycle retained; protocol/diagnostic and extension provider conversion responsibilities allocated |
| Values/stdlib | All changed values source/test/manifest paths inspected; unchanged conformance/barrel evidence reused | Exact array omission, engine-resolved omission, contextual decimal construction and requested/default/source locale semantics traced | Form/decimal joins challenged by platform; current localization change treated at declared scope | Existing values private split retained; stable thin stdlib owner retained; no cloned data plane |

No test, build, compile, business journey, extension package/install or UI-host
interaction was executed by this review. Reading tests establishes their
intended assertions and omissions; it does not establish their results.

## Contracts and ordering that moves must preserve

`REQUIREMENTS.md` makes adoption, one way per SaaS primitive, owner-derived
interfaces/dependencies and independently authored examples authoritative.
`DESIGN.md:291–306` separates role/subject/current-team facts from read grants,
with no read policy meaning deny. `DESIGN.md:1023` keeps `canApp()` a callable
factory without spreading `appDefinition`; declaration facts remain on their
owner. `implementation/CONTRACTS.md:21` requires one producer-authored catalog
instead of independently evolving Rust, TS, MCP and form schema mirrors.

The parser remains lossless and rollback-aware. Resolution precedes typing;
deferred unresolved diagnostics follow claimed enum cases. Effects now perform
a message prepass before recording checked descriptions (`effects.rs:908,
1038–1070`), preserving forward imported/static wording and owning source
language. Examples retain independent expectations and their fixture/sequence
authority. Migration consistency is checked during IR decoding, before its
transition is emitted (`ir.rs:4787`); it does not suddenly run in the general
analysis pass because the file lives in `analysis`.

The compiler provider tables in `analysis/catalog.rs:1190–2026` are current
frozen producer transcriptions, with ratification tests at `2030–2702`. They
are retained implementation debt, not a second permanent contract authority.
The cutover is a versioned owner-generated catalog covering those same
capabilities, ordered inputs/results/nominal leaves and delivery observables;
Rust consumes it through the existing catalog reader, parity/negative consumers
switch together, then manual table bodies and their transcription-only tests
retire. Until that join exists, preserve exact versions and unknown/unsupported
behavior. No new service/package or speculative Rust data model is selected.

## Findings and implementation gates

### C1: canonical policy reads the wrong producer surface

**Observation, independently confirmed; critical workflow blocker.** The
compiler adds policy only to `appDefinition` (`js.rs:3421–3422`). Its
`canApp()` return includes operations, callable rule maps and handlers, but no
policy (`4997–5020`). Runtime `importPolicyRegistry` returns `mod.canApp()`
(`packages/cloudflare/src/runtime/invoke.ts:1495–1496`), and the model scan
reads that returned object's `policy` (`1554–1570`). Missing operation policy
becomes `undefined` (`587–588`) and then `public` (`620–621`); missing model
policy becomes a public grant over all declared fields (`790–795`). Canonical
CRUD executes the core executor and skips the emitted gated handler
(`2456–2458`). The join-point comment at `719–727` describes an actual current
gap, not a resolved historical note.

**Authority:** no policy means deny (`DESIGN.md:306`); callable-only
`canApp()` is explicit (`1023`). **Recommendation:** make the actual authored
manifest a validated, versioned input to canonical preload, distinguish absent
policy from declared ungated operations, and fail closed while unavailable.
Preserve `appDefinition` ownership rather than silently moving metadata into
the callable registry. Verify compiled protected CRUD and no-policy reads
through actual canonical invocation, with unauthenticated, foreign-team,
revoked and authorized actors, plus unchanged-state rejection observations.
This review did not execute an exploit or a successful compiled journey.

### C2: form selection still does not produce renderer descriptors

**Observation, independently confirmed; existing blocker retained.**
`ir.rs:6158–6280` emits `operation`, `display`, `arguments` and string-selector
`fields`. `default_form_fields:6336–6378` selects stored fields from model
symbols, excluding derives but without applying the operation allowlist or
server-owned/default/bound-argument input decisions. JS forwards those props
directly (`2931–3003`). `FormProps` requires typed `FormFieldDef[]`, action,
operation identity, mode, timezone, submit caption and id prefix
(`packages/contracts/src/presentation.ts:768–788`); UI rendering reads
`field.path` and type information (`packages/ui/src/forms.ts:633` onward).
Handbuilt form registrations do not supply a compiler caller for that join.

**Recommendation:** owner-derived writable input schema → form selector
resolution → dispatcher metadata → UI renderer, including explicit/default
selectors, bound/omitted values, arrays/nullability, child linkage, update
versions, server/default fields and rejection redisplay. Keep selectors as
source metadata, never confuse them with completed render descriptors.

### C3: decimal acceptance stops before executable lowering

**Observation, independently confirmed; unsupported behavior distinguished.**
Contextual integral-to-decimal literal checks and the exact bigint
`decimalFromInteger` construction now exist (`types.rs:15129–15169`,
`packages/values/src/decimal.ts:378–389`). JS's ordinary decimal literal arm
still emits `E6008` and a throwing placeholder (`js.rs:1495–1504`). That is
fail-closed missing emission support, not proof that the accepted source runs.
The new decimal constructor is exported by the values wildcard barrel;
stdlib's deliberately enumerated facade has not automatically requested it.

**Recommendation:** one catalog-backed exact constructor and literal-lowering
join, retaining no variable coercion, int overload preference, 38-digit/range
limits, nullable/array/default/bound contexts and exact wire semantics. Do not
route through Number or claim checker tests close runtime emission.

### C4: generated context fields miss the admitted runtime carrier

**Observation; independently cross-read with runtime reviewer.** Ordinary
`actor` and `now` lower to `c.actor` and `c.now` (`ir.rs:2374–2375`), then
ordinary JS member access. `HandlerContext` exposes `caller`, `clock`, store,
memberships, preferences and optional canonical scope
(`packages/cloudflare/src/runtime/context.ts:90–102`); `createContext:128–140`
never installs `actor` or `now`. `runScenarioSeam` passes a live host callback
as `clock` (`invoke.ts:2372–2380`). Canonical state invocation froze
`context.now` once before its retry loop (`packages/state/src/invocation/invoke.ts:
178–190`). Thus source `now` first sees a missing member; custom handlers
reading `clock()` additionally see a potentially moving host value. Merely
freezing that callback would not repair generated member access.

**Recommendation:** establish the canonical generated-context contract and
construct actor/now from the admitted call, preserving actual user/datetime
representations, public actor nullability and frozen retry semantics. Test
compiled source that uses both fields across a forced fence retry.

### C5: editor restart can orphan a client process

**Inference from source, independently challenged; no execution.**
`editors/vscode/src/extension.ts:400–408` nulls the global client while awaiting
the old client's stop. A second command/configuration restart can start a new
client immediately; completion of the first then starts another and overwrites
its reference without stopping it. Opening a document during the same interval
has a similar start path. Event handlers use the module-global client, so the
defect is an orphan child rather than duplicate registration.

**Recommendation:** serialize/coalesce restart, reopen and deactivation within
the extension's one lifecycle owner. A deferred-stop interleaving test should
observe one live process and a settled final reference.

### C6: unsupported policy and provider/model shapes remain explicit

Compound/expression operation gates still emit `E6008` in `by_member`
(`js.rs:4097–4123`); manifest `guard_spellings:1104–1113` marks such content
`gated`. Runtime transcription rejects gated/when/require entries. Once C1 is
closed, that refusal must remain fail closed until full policy execution joins.
It is separate from canonical state `ByPredicate` compound revalidation
behavior: handbuilt state definitions can express predicates the compiler
currently cannot emit. The runtime review owns its false-void membership edge.

Provider nominal/result schemas and richer artifact descriptors are implemented
at source scope, but they do not themselves prove durable sends, receipt
association, completion admission, installed service availability or opaque
reference permissions. Preserve known gaps and negative-case witnesses in
`b4_witness.rs`; scoped draft declarations and desired JS remain proposals.

## Target owners and precise allocation changes

All filenames below are proposed internal leaves. They are not implemented
exports or promises of final file sizes. Existing public names/barrels remain.
The previous allocations for parser productions, resolve/type/effects/examples
passes, IR/JS emitter, LSP backend/protocol/session and values
schema/wire/ICU/temporal families remain coherent **responsibility seams**;
their old numeric ranges and size ledger must not be reused as current proof.

| Current source | Selected target leaves and responsibilities |
| --- | --- |
| `compiler/src/cli.rs` | `cli/mod.rs`: shared analyzer/dispatch/options/help/check/compile/policy/lint/platform routing; `cli/docs.rs`: checked extraction plus subprocess JSON renderer (`879–1125`); `cli/format.rs`: stdin/file formatter and atomic write helper (`1214–1382`, shared by docs); `cli/tests.rs`: current inline command/IO cases (`1540–2078`). One binary, no separate process beyond the existing renderer boundary. |
| `compiler/src/docs.rs` | `docs/mod.rs`: reference orchestration/declaration/field/input/operation extraction (`334–643`); `docs/model.rs`: frozen carriers/constants (`100–327`); `docs/examples.rs`: fixture/table/sequence attachment (`643–797`); `docs/descriptions.rs`: checked/static/imported wording and default selection (`798–945`); `docs/source.rs`: portable identity/hash/span handling (`946–1092`); `docs/json.rs`: the single v1 serializer (`1093–1392`). Preserve full source spans, deterministic identity and absent/empty distinction. |
| `compiler/src/analysis/catalog.rs` | Keep `catalog.rs` as load/signature/lookup coordinator; `catalog/providers.rs` owns retained frozen tables and their helper lookup (`1190–2026`), explicitly pending owner-catalog cutover above; `catalog/provider_tests.rs` owns current transcription ratification (`2030–2702`). No independent permanent schema authority. |
| `compiler/src/codegen/js.rs` | Add `js/descriptors.rs` to the previous selected JS leaves: operation/model/delivery protocol carriers/JSON (`135–819`) and descriptor extraction (`4207–4960`). Keep authored app metadata in `definition.rs`, executable maps/functions in `registry.rs`, and one emitter/import set. |
| `compiler/src/codegen/ir.rs` | Add `ir/decode_forms.rs` to the previous selected IR leaves: canonical operation selection, explicit/default input selectors and form/control owner scope; current form target duties are `6158–6380`. Ordinary catalog/container/collection decoding remains `decode_ui.rs`; C2 must be settled before promising completed descriptor logic. |
| `compiler/src/policy.rs` | Retain: one declared-policy introspection format and source-ordered CST walker. It is reporting, not executable authorization. Preserve `policyPage` consumer shape and raw predicate spelling. |
| `compiler/src/analysis/migrate_check.rs` | Retain: desired owner-schema/predecessor/directive consistency. Runtime owns old-schema collision/liveness/state; do not infer it from `.can` desired declarations. |
| `packages/contracts/src/state.ts` | Preserve previous state family split, adding `state/execution.ts` for `EXECUTION_CONTRACT_VERSION`, pinned versions, canonical operation/model/input/default/provider descriptors and observation/recipe boundary (`687–920`). Existing migration/storage families cover newly added lifecycle failures/flips (`616–672`). No `state/fence.ts` is needed: this file defines no new FenceScope/revalidation family. |
| `packages/contracts/src/reference.ts`, `artifact.ts`, `services.ts`, `work.ts` | Retain their current neutral protocol filenames. New reference model is one versioned wire shape; provider contracts/nominal values and observables remain authored TS owners, consumed by Rust. Add no per-language catalog copies. |
| `editors/vscode/src/client.ts` | Prior `client.ts` coordinator, `protocol.ts` UTF-8/RPC framing and `diagnostics.ts` conversion remain selected. Current custom client is constrained by the explicit empty-typeRoots/zero-dependency gate (`client.ts:19–25`, package compile script); a standard-client replacement requires changing that policy. |
| `editors/vscode/src/extension.ts` | Retain lifecycle/activation/restart in `extension.ts`; add `src/providers.ts` for VS Code hover/completion/location/rename/token/action adapters and conversion (`35–350`). This adapter uses the same client; no second session/process owner. |
| New command/test/icon leaves | Retain `compiler/build.rs`, all three completion scripts, new Cargo targets and `tests/common/lsp_driver.rs`, editor icon generator/native assets, preview evidence and demo shell. Embedded completion paths, Cargo module paths, release archive and `.vscodeignore` joins must move with owners. |
| Values private families | Retain prior allocation; schema omission owns `UPDATE_OMITTED`/`ENGINE_RESOLVED`, server/default/required/null/array ordering. Values owns one exact decimal/locale implementation. UI sharing still requires the declared profile agreement, not textual deletion. |

The extension provider leaf is justified by actual added API conversions, not
by its length. Future custom-client source moves must update explicit compiler
inputs in `package.json`, host ambient declarations, shipped output and editor
tests together. The TextMate grammar stays one shipped JSON; frozen audit
snapshots stay intact. Python syntax retirement remains gated on syntax/location
parity and caller migration; no new Python parser package is selected.

## Exclusive task packets and dependency order

| Packet | Exclusive writers | Dependencies/gates | Required verification at implementation time |
| --- | --- | --- | --- |
| C-POLICY | Artifact/policy contract owner; compiler descriptor/definition owner; Cloudflare canonical preload owner | First serving gate C1; one authored manifest authority, callable-only registry retained | Compiled protected CRUD/read + denied/no-change/current-team/revocation cases through real invocation; missing/unsupported manifest refuses |
| C-CONTEXT | Shared invocation context owner; generated context constructor; IR context lowering | C4 representation contract first; no independent clock carrier | Compiled actor/now source + forced retry demonstrates frozen value and faithful public actor |
| C-FORMS | Compiler form/descriptor owner; interface form dispatcher; UI form renderer owner | C1/C4 as relevant; C2 writable schema and bound arguments settled | Compiled create/update/scenario forms render then submit canonically; hidden server fields, omissions/defaults, errors/version/linkage redisplay |
| C-DECIMAL | Values catalog constructor owner; JS scalar/literal owner; thin stdlib assembly owner | Catalog/export request and exactness contract, C3 | Source acceptance + emitted execution + wire/range/negative coercion/overload cases |
| C-EDITOR | Extension lifecycle and provider files only | C5; custom-client policy retained | Deferred stop/restart/reopen/dispose interleavings; real stdio provider join; package compile/includes at next broader gate |
| C-REFERENCE | Docs extractor/serializer/source identity; CLI docs/format files; owning TS renderer | Reference v1 stable; platform renderer owns localized escaping/validation | Existing extraction determinism/absent-empty/authored-sequence tests, fixed argv/stdin/failure discipline and actual rendered-doc CLI join |
| C-CATALOG | Producer catalog exporters; Rust catalog consumer/providers; parity witnesses | Owner-generated capability/result/observable schema contract before manual mirrors retire | Cross-owner exported catalog parity, invalid versions/unknown kinds, signature/default/order facts and real compiler callers |
| C-STRUCTURE | Exclusive source owner per proposed pass family | Preserve established ordering; prerequisites above block dependent runtime claims, not independent file moves | Narrow owning tests, then crate/package consumer checks, source maps/examples/actual larger joins; source-path includes/build/install exports updated together |

Avoid simultaneous writers to `cli/mod.rs`, the shared emitter/IR facade,
contracts barrels or the root build/config surface. Producer owner requests
precede stdlib assembly. A mechanical structural packet cannot declare C1–C6
closed merely because old tests continue to pass.

## Consultation and pending policy decisions

No fresh difficult language/package choice was selected in this review. The
existing JEV semantic-package-retention consultation can be reused at that same
scope, with its evidence limits. Closing the actual policy producer join follows
existing declared authority; this review does not override it with a new registry
metadata policy. A proposal to change that authority, remove the editor dependency
constraint, or choose a new schema ownership instead of the declared producer
catalog would require verified balanced alternatives and the repository's three
independently worded JEV requests. Values/UI display profile reconciliation
remains a real decision gate before implementation sharing.

Platform independent challenge confirmed C2, C3, C5, the current constrained
editor policy and the new CLI/docs/descriptor allocation. It required the
explicit catalog-mirror retirement gate, which is recorded above. Runtime
cross-challenge confirmed C1 from both sides and qualified the compound gate
scope; C4 was refined to missing generated context fields before its additional
moving-clock risk. No reviewer agreement is counted as executed behavior.

## Final planning artifact challenge

Independently checked `ownership.md`, `findings.md`, `tasks.md`, `lanes.md`,
`allocations.json` and `target-tree.json` against the source and the scoped
evidence above. The generated tree contains all 394 pinned paths in this review's
ownership scope; every allocation destination exists in the target ledger,
with no duplicate target path. The form, policy, context, decimal and editor
joins remain open. The corrected compound-predicate finding properly describes
false refusal of legitimate membership-free branches, and the transitive-scope
finding distinguishes direct state/work APIs from the narrower claim-first
Cloudflare caller.

Corrections sent to the coordinator: spell current completion leaves as
`compiler/can-completions.{bash,fish,zsh}`, remove residual new state “fence
family” wording, and add the `state/execution.ts` responsibility record for
versions/descriptors/observations/recipes. Record the values/UI equal-profile,
locale/error/exactness and differential-coverage gate on their shared target
allocations; the package-layout consultation does not settle that semantic
decision. Keep R02 as sole writer of the shared values renderer/locale leaves,
and assign C13 service/file catalog producer portions to their actual owners.
Existing custom-client constraints remain selected; replacement needs a policy
change rather than being a necessary unresolved migration. Dependency gates
apply to affected families and consumers, so independent CLI/docs/LSP/editor
and syntax work is not blanket-blocked by unrelated runtime joins. These are
planning corrections, with no product execution or implementation performed.
