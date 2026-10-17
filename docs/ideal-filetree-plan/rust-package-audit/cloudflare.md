# Cloudflare: additional Rust benefit audit

Source: `08dc8c3928f53c7a06984136ac52ff944360075c`, 18 October 2026.
Planning only. [Coverage](cloudflare-coverage.json) accounts for all 565 tracked
paths. Production imports/function responsibilities were screened; candidate
bodies, representative host/authority joins and their control tests were read.
This is portfolio and responsibility coverage, not exhaustive line-by-line
correctness certification. Tests/fixtures and held preparation artifacts are
inventoried separately; no behavior, performance or build was executed.

## Defining responsibilities and current allocation

| Source area | Responsibilities and disposition |
| --- | --- |
| `src/cli/` | Command syntax, stdin/stdout envelopes, source workflow, compiler/test/build delegation, interrupt disposal and local serving. Retain TS process/host owner. Small option parsers have no demonstrated Rust benefit. |
| `src/dev/` | Stable source capture, compiler invocation, previews, private socket/process identity and stale-owner recovery, installed browser/runtime inputs, local bindings, examples, failure projection, construct help and JEV transport. Retain TS. Hashing already uses native crypto; loops mostly read filesystem/process/host state. Local query/example hooks carry JS callbacks and real stores. A port cannot remove these host boundaries. |
| `src/generation/` | Request/config parsing, source association, runner adapters, protocol framing, MCP candidate submission, leases, attempt fences, journal recovery, verification/promotion and generated output controls. Retain host operations and public JS errors. Pure diff is the one conditional new compute candidate below. `association.ts` has only its own tests as tracked TS importers; its potential quadratic matching is not an established production bottleneck or removal authorization. |
| `src/deploy/`, `src/release/`, `src/upgrade/` | Installed producer closure, import edits/maps, literal portable issuer, browser/Worker assembly, verified asset staging, exact release hashes, plan review and explicit activation/publication. Existing P/native preparation and C04 delivery cover the intended Rust/host split. Keep publication, filesystem containment, package resolution, bundler invocation and permissions TS. Accepted D02–D04 library integration is retained; no second Rust scanner/map programme. |
| `src/preparation/`, `preparation/`, scripts/conformance | Existing TS host protocol/publication and Rust artifact/input/compatibility/modules/plan/render/review/release/job candidate. **Existing P scope, HUMAN HOLD.** Inventorying it does not authorize preparation, native packaging or publication. No new Tokio/process/serializer architecture is proposed. |
| `src/runtime/` host adapters | D1/R2/DO selection, original source and field inventory, Files/Work/provider bindings, event/queue intake, receipt/progress, native membership/query/reference/context capabilities, HTTP/MCP grants, generated views, source maps and prepared validation. Retain TS host identity, lazy property/operand reads and async sequencing. Public metadata is not the authority behind the private WeakMap/capability issuers. |
| `src/runtime/invoke.ts` | See the mixed-file map below. Retain orchestration; exact numerical/validation primitives belong to existing Values, closed Work decisions to existing W. A 20,018-line file is a maintainability signal, not a Rust port boundary. |
| `src/worker/` | Real Worker entry/main/assembly, dynamic installed imports, owner storage routing, credential joins, HTTP/CSV/MCP/page handlers, cohort/fanout dispatch and shutdown. Retain JS/Web APIs and current package producers. Native-looking helper names refer to compiler-emitted JS/runtime provenance, not automatically Rust execution. |
| Package configuration, distribution, tests, authored/generated fixtures | Retain with owning producers/consumers. Current production deps already include parsers, map libraries, bundlers, Miniflare and all ordinary package owners; work-kernel is dev-only. Tests provide original workflow witnesses, not production kernels. |

## Mixed `invoke.ts` responsibility map

The named declarations throughout the file were inventoried, then the candidate,
new compiler integration and authority boundaries were inspected internally.

| Current line region | Distinct duty / extraction implication |
| --- | --- |
| 198–674 | Stack/frame mapping, invocation errors and occurrence scope. Existing map libraries; preserve original thrown object/errors and async context. |
| 675–2013 | Source policies, original model/read metadata, dynamic State producers, contract versions and required capabilities. JS descriptors and source provenance are not portable JSON facts. |
| 2014–4907 | Commit guards, verified assembly/canonical descriptors, native scenario/file/call/query/reference/membership binding and actual source census. Keep host validation and checked producer imports. |
| 4908–7417 | Store/membership assertions, staged overlays, uniqueness/write folding, schema codecs, native row/ref views, lazy reads/containment, owner policy and source snapshots. Linear fold helpers remain TS; typed codec work is existing A/V, not another serializer. |
| 7418–10220 | Scenario execution, ordered instructions/hooks/Requires, source guards, final effects, canonical mutation and delivery progress. Current Customer recover producer remains intact; source failures and transaction stages must not move. |
| 10221–12498 | Checked completion/change routing, Identity removal ingress, due and retained handler occurrences, real source/membership revalidation. Keep scheduling/IO/authority; no inference that all these facts are eagerly inspectable. |
| 12499–14911 | Selected receipt reads, File/reference authority, ordinary/authority report reads, source predicates and paged collections. Source predicates run over the granted domain before UI data filters; final current authority/revision is rechecked after transforms. State's optional ordering leaf does not own this work. |
| 14912–17182 | Installed dispatch registries, fences, provider preclaim/attempt/outcome and recovery sweep. Existing W demand/decision families; selected actual recovery consumer is already accepted. |
| 17183–20018 | Fanout metadata, retained cohort resolution, claims, lifecycle outcomes, scheduler/source body, navigation, progress and provider cancellation. Existing finite W row/linkage slices; W09 request/resume remains separately deferred. |

`native-records.ts` binds originals in WeakMaps; receipt rows retain an owner and
live row resolver. Snapshot admission rejects getters, hidden members, holes and
non-finite data without executing accessors and preserves immutable protected row
identity. `native-value-schema.ts` walks only demanded original reference paths.
These are concrete reasons not to serialize whole rows into a generic Rust engine.

## Additional candidate: generation text diff

`generation/controls.ts:textHunks` (4286), `myersDiff` (4360) and real
`runDiff` (4161) form a finite bytes → hunks boundary. Source reads confirm strict
UTF8 round-trip classification, LF splitting including trailing empty lines,
Myers tie selection, `n*m > 4,000,000` delete/insert fallback, three-line context,
50-hunk/500-output-line limits. The full trace is allocated before output limits;
the product threshold alone is not a general memory bound. This is a static
allocation observation, **not a measured stall or a newly established defect**.

Compare a memory-bounded TS algorithm/reuse against a Rust leaf only if actual
changed-file workloads justify the work. Preserve exact binary classification
(NUL alone is not binary), CR bytes, equal-line ties, hunk positions/context,
fallback output and truncation flags. A mathematically valid different diff is
still an observable change. If a new input/work cap or hunk policy is desired,
name that decision separately; don't silently tighten public acceptance.

Owner remains Cloudflare generation. First finite output: workload/compatibility
and cost comparison ending in retain-TS or one exact language proposal. A later
candidate must join the actual `diff` command, include input/output copying and
serialization, startup/asset cost and worst permitted repeated/unequal lines.
Current `controls.test.ts` has real diff control cases and basic binary/large
`textHunks` checks, not a complete tie oracle. Do not port leases, saved-group
ownership, candidate authorization or journal promotion. There is no accepted
new native delivery owner for this candidate; don't hide it in held preparation
or add it to Values solely to obtain a Wasm loader.

## Other pure-looking mechanisms considered

- `collapseStagedWrites`/`netStagedUniques`: real linear grouping and fold,
  original first-touch order/version bases and remove/recreate pair. Row payloads
  and host object references would require conversion; a new metadata-index
  transport lacks a demonstrated need. Keep TS, separate history/effect order.
- `given-unique-keys.ts:scanGivenJsModule`: a conservative saved-source lexical
  profile with raw escaped specifiers, UTF16 offsets and unresolved-edge refusal;
  it is not the same acceptance contract as deploy `module-imports.ts`. Aligning
  profiles/libraries might help maintenance, but a generic Rust JS parser is not
  a drop-in replacement. Preserve compiler correspondence, don't conflate profiles.
- `runtime/sourcemap.ts`: raw ordering, modulo-32 decoding and early-break lookup
  are deliberately compatible; jridgewell handles mechanics. Compiler Rust map
  code is not a reason to reopen accepted D02–D04.
- Generation `stableStringify`, request/config checks and artifact validation:
  public JS reads/string ordering and exact stored/review bytes matter. Hashing is
  already native; current host catalog and held P owners cover relevant reuse.
- Page cursors use host WebCrypto HMAC, canonical identity codec, exact domain/
  version/time/size checks. A Rust crypto dependency would add copying without
  replacing source/actor/query binding or current read authority.
- Source captures, manifests and graph traversal mostly perform filesystem,
  resolution, crypto or existing parser/bundler work. Reuse/caching or stronger
  exact ownership is often a better first comparison than language replacement.

Independent source challenge of these candidates is in
[adapters-ui.md](adapters-ui.md#independent-challenge-of-selected-cloudflare-seams).
The candidate is optional and unmeasured. No existing complete review checkpoint,
canonical task acceptance, backend default or release changes here.
