# Shared implementation boundaries

These are high-level interface obligations for producer-owned bootstrap PRs. They are not implemented APIs. Reviewed `.can` drafts and desired-output witnesses define the required behavior; compiler and stdlib producers derive exact signatures and implementations from those drafts and accepted language contracts. Production consumers must not guess installed imports or make competing definitions. Draft witnesses may specify minimal coherent target APIs explicitly labeled desired/unimplemented; the owning producer formalizes and implements them. Early additions can be compatible; a breaking change requires the affected owners' explicit handoff and a coherent merge sequence.

| Boundary / owner | Required contents and meaning | Consumers |
| --- | --- | --- |
| Source/analysis, L1 | Immutable source hashes; recoverable lossless CST with `#`/`##` attachment; canonical symbols, types, owner graph, spans and diagnostics; checked program only after normative checks pass | L1 codegen/lint/format/LSP share it |
| Compiled artifact, L1 | Versioned appDefinition, callable registry, pages, resources, linked library requirements, source maps, separate test artifacts. Preserve DESIGN §13; reject incompatible/missing capabilities | L3–L7 |
| Values and builtin catalog, L2 | Exact integer/decimal/money/temporal/identity representation; structural equality; schemas/constraints/default distinctions; canonical wire encodings and pure signatures | All |
| Invocation and commit, L3 | Verified principal/team/owner/operation identity, expected versions, normalized inputs, frozen operation clock, admission kind, safe results/errors; atomic domain/history/replay/work-intent commit | L4/L6/L7; compiled handlers |
| Durable work, L4 | Stable intent/occurrence IDs, frozen arguments, current dispatch guard, claim and replay identity, typed completion/unknown/skipped outcome, selected receipt observation revision and retention | L3 commit, L6 routes, L7 deployment/recovery |
| Services/files, L4 | Bound provider identity and supported operation/features; verified event ingress and file finalization/provenance; stable file identity distinct from raw bytes/URL | L1 catalogs, L3 attachments, L5 display, L6 uploads |
| Presentation, L5 | Canonical component props and page descriptors, admitted bindings, operation/reference bindings, safe message values, shell and fragment rendering | L1 emission, L6 dispatch |
| Identity/wire, L6 | Authenticated context construction, expiry/revocation, user/team role lifecycle; one typed operation envelope, errors and uploads for HTTP/MCP | L3 admission, L5 forms, L7 host |
| Deployment/examples, L7 | Artifact/resource/runtime compatibility, actual binding/secret references, staged activation/upgrade state, real fixture provisioning and outcome reports | L1 CLI, all runtime producers |

## One authored contract per library capability

Presentation has an approved full-catalog requirement: [all 68 pinned daisyUI components](../design/UI-COMPONENTS.md), with contextual words, payloads, allowed parents/children/slots, appearance subsets, canonical bindings and interaction duties in one producer-owned catalog. The old short mapping tables are not an exhaustive allowlist. L5 defines it once; L1 consumes it for source checks/emission and agent discovery. Approved language scope and implemented feature availability are distinct: advertise actual support precisely and keep every mandatory missing component as an owned task. Navigation derives from admitted page descriptors. The shared static shell is the right-sidebar page menu, bottom-right user menu, common user configuration dialog and canonical login screen; page-local components cannot replace it. L6 supplies canonical identity/transport, not a second account/settings flow.

Each library owner authors its signatures, descriptions, type/constraint and effect requirements once with the implementation. The build exports a versioned machine-readable catalog that Rust consumes. TypeScript implementation types and exported catalog must be checked against that same declaration. Do not manually maintain a Rust builtin table, a TS schema table, a MCP schema and a form schema containing the same information. Generated catalog files are build artifacts, not a new app configuration format. At B0, a producer contract/catalog PR may merge with its own shape/conformance tests and explicit test-only consumer fixtures; consumers need not be implemented yet, and no incomplete production feature is advertised as supported. At B1, demonstrate that same real signature reaching Rust checking, runtime validation and consumer discovery.

Define a common catalog envelope/version in the first L1/L2 contract join; L3–L6 add their owned entries. Exact-value tags, record/file/reference provenance and numeric bounds must survive JSON transport. Never serialize BigInt with ordinary JSON or collapse decimal/money into JS Number. Library feature availability is checked at build/activation; missing implementations cannot masquerade as callable contracts.

## Dependency direction

**Design flows from drafts to implementation:** lane 08 designs the app frontend first; lane 05 derives UI contracts/renderers and lane 01 derives checking/emission from reviewed source/target pairs. Other stdlib owners likewise implement semantics established by the drafts. Runtime package dependencies below do not reverse this design relationship. Do not require installed APIs or successful execution before a faithful draft can be authored/reviewed; record implementation gaps with their owners.

- `contracts` contains data/types only. L2 values depend on runtime standard APIs and vetted value libraries; they never obtain current actor, time, network or records implicitly.
- State uses values and provider-neutral ports. State is the only authoritative commit engine. Work/files/identity submit registered, constrained system commands through it rather than raw SQL around the fence.
- Work/services/files use the state transaction ports and their owned adapters; state receives staged typed intents and registered validators without importing the public stdlib façade back into itself.
- UI obtains records and operations through authorized interfaces; interfaces establish identity and use canonical state admission. Neither owns a second CRUD/policy engine.
- Cloudflare assembly wires real bindings and handlers together. Node-based build/dev code must not enter Worker bundles. Testkit invokes compiled operations through production admission and its separately scoped fixture authority.
- `@canlang/stdlib` is the thin public export assembly owned by L3, consuming producer packages. `@canlang/ui` remains the presentation surface. Internal package structure must not multiply app authoring choices.

## Transactions, identities and disclosure

All domain writes, audit/history required by accepted rules, replay receipts, schedule replacements and outbox intents commit with the same owner fence. D1 and DO implementations share the language contract, not an imaginary cross-store transaction. D1 fence failure must abort its batch; a zero-row update alone is insufficient. Lane 3 owns that proof. Auth/session/membership mutations which affect that authority must use their declared owner path and revocation boundary; an authentication library may not silently create a bypass database.

Incoming user JSON is never a trusted invocation context, record projection, finalized file or delivery handle. L6 authenticates and resolves the selected app/team; L3 checks the canonical operation, fields/versions/grants; L4 validates source/provider evidence. Result projection is enforced before disclosure through UI, MCP, examples or logs. User-operation invocation remains canonical even when exported.

A successful provider call is not a business completion. Accepted booking, settled money, approved evidence and replacement consent remain authored transitions. Retry transports do not authorize another charge or discard unknown outcomes. File MIME/type validation is distinct from authorized finalization and from permission to attach/read it.

## Query and time boundaries

L2 implements pure collection/scalar helpers over supplied values. L3 implements record queries, authorized limits, counts and aggregates; a collection helper cannot materialize/truncate a protected query to bypass that contract. Viewer grants precede viewer filters/projections as specified; policy/invariant/mutation contexts use their accepted owner authority. Runtime failures must not silently turn into permission booleans.

The operation clock/actor are supplied by L3/L6. L2 computes dates, timezones and checked arithmetic from explicit values. L4 owns timers, admitted occurrences and replacement/cancellation. Company working calendars, renewal consent, grace periods and escalation remain business policy. No universal scheduling or reconciliation default invents them.

## Deferred semantics are visible

The population-enumeration/history/dependency proposals and new AI declaration sketches are not automatically adopted. Emit precise unsupported diagnostics for required unimplemented/undecided constructs, implement independently settled features, and record the exact design dependency. Preserve three-rewrite JEV consultation and approval blocks; implementation pressure does not authorize a bypass. The existing draft coordinator owns draft corrections, including the current Feedback/progress handoffs.

Provider adapters and typed library functions can be implemented where their contract is settled without adding vendor-specific grammar. For a new consequential language rule, deliver verified alternatives, the required consultations, an accepted rule and Can/JS examples before spreading it across libraries. Shared protocols belong to producer contracts; app-specific thresholds, prompt rubrics, budgets and approval decisions stay visible in app source.

## Migration and BDD joins

L1 checks and compiles explicit migration declarations. L3 executes owner-local transforms under fencing and constraints. L4 exposes pending-work compatibility/inventory. L7 coordinates staging/activation/recovery and preserves deployed evidence. No lane creates a parallel migration interpreter.

L1 compiles inline examples separately from production. L7 schedules fixtures/calls/assertions; L2 supplies exact expected-value equality, L3 runs real admission/transactions, and L4 supplies controlled provider/event/file fixtures under isolated test authority. A setup/type error cannot satisfy an expected business rejection. The runner must not interpret `.can` independently or bypass the production dispatcher to make a test pass.

## Source correspondence requirements

These retained correspondences define required behavior. They do not assert that an owning mechanism is absent; reuse accepted scope and select unmet consumers only from [REMAINING-WORK.md](REMAINING-WORK.md).

### Ordinary nullable flow

[INFERRED] Bucket b, high confidence. Explicit null tests should provide ordinary continuation facts while remaining separate from permission reasoning. Extend the existing analysis rather than weakening receiver, arithmetic, trim or argument contracts separately.

Specify true/false facts for equality and inequality, reversed operands, parentheses and NOT. AND's right operand receives left-true facts; OR's receives left-false facts. Branch joins retain facts valid on every reaching path. Successful requirements carry facts forward. Key facts by resolved declaration and path, distinguish immutable local values from mutable fields, and invalidate relevant facts around writes and mutation-capable calls.

Acceptance includes the six original patterns and guarded nullable text/datetime operations. Invalid controls include unguarded access, reads before guards, null admitted by another OR arm, alias writes, contradictory branches and zero-iteration loops. Safe-access comparisons against nullable values must not invent presence.

Cost: more flow bookkeeping and conservative rejection where alias mutation is uncertain.

### Readable selectors

[INFERRED] Bucket b, high confidence. Share canonical resolved member information with purpose-specific checks for reading, filtering, granting and writing. Preserve owner, type, supported leaves and reference/value provenance.

Acceptance covers parent, safe metadata, value members, nullable schema intermediates and imported aliases. Unknown leaves, invalid terminal descent, unauthorized traversal and metadata mutation remain invalid. A schema selector supplies no runtime non-null fact and no automatic permission grant. Preserve existing B4 delivery-leaf support.

Cost: a shared semantic member/path boundary with context-specific validation.

### Actor facts after admission

[INFERRED] Bucket b, high confidence. Carry successful caller admission facts inside Boolean continuations and into CRUD when. Reuse the flow machinery and declared authentication predicates.

Acceptance retains nullable actor for public alternatives, other-subject roles, helpers before admission and signature defaults. Trusted payload users do not become callers. Preserve existing tests in [b4_check.rs](/Users/vince/Projects/canlang/compiler/tests/b4_check.rs:89).

Cost: contextual admission bookkeeping.

### Canonical standard and bound interfaces

[INFERRED] Bucket b, high confidence on missing interface production and resolution; medium on each unresolved recipe. Supply owning information while retaining strict validation.

Inventory imported names against accepted contracts. Reconcile versions and earlier producer DTOs. Export request/result/error schemas, effects, event and observable relationships from one authoritative producer definition; preserve canonical identity through aliases. Use that information for checking, runtime validation and discovery. Installed capability checks remain a separate build/activation obligation.

Start with common operation/delivery/email contracts, then generation/image/workflow interfaces, judgment/mailbox contracts and corpus operations. Reuse delivered adapters. Keep missing/private/misspelled members, incompatible bindings, wrong associations and forged protected handles invalid. E3019 remains valid when the real schema is absent.

Cost: producer catalog/contract work and explicit compatibility handling.

### Creation defaults and input schemas

[INFERRED] Bucket b, high confidence. Carry requiredness, omission, default, server initialization and derived distinctions separately from representation types through checking, effects, IR, artifacts, runtime, forms and MCP.

Ordinary arrays omit to empty; required arrays reject omission. Preserve documented nullable/default behavior, protected initialization, update omission versus explicit null, and derived/server exclusions from writable inputs. Defaults execute in their documented context/order and do not rerun on replay or ordinary updates.

Acceptance uses actual source-derived descriptors and existing values conformance, including parent, actor/time, server fields and replay. Model stored fields are not automatically writable operation inputs.

Cost: a shared semantic descriptor join and deliberate correction of contradictory emission expectations.

### Contextual structural values

[INFERRED] Bucket b, medium-high confidence. Validate literal construction recursively against a known expected closed contract. Preserve canonical identity and constraints; leave arbitrary named-type conversion to its own rule.

Acceptance covers known/unknown fields, required/default/nullable members, nested contracts/arrays, enum domains, exact bounds, model references and protected handles. Runtime fixture normalization agrees with static checking. Wrong shape and forged provenance remain invalid.

Cost: expected-type propagation and recursive validation using owning schemas.

### Imported containment

[INFERRED] Bucket b, medium confidence, with a design gate. Separate declaring package identity, local executable closure, parent identity, inherited team/storage, mutation authority, reverse-child identity and migration consequences.

Local imports and deployment-bound remote schemas require different treatment. Import or containment supplies no automatic parent mutation authority. Acceptance retains source relationships while testing alias/order/composition parity, wrong parent, cross-team parent, missing/archive state, cycles and unavailable ownership. Prove applicable persistence/query behavior on actual storage and respect D1/DO boundaries.

Cost: a canonical ownership graph and lifecycle/migration rules.

### Event and hook mutation provenance

[INFERRED] Bucket b, high confidence for spelling-based rejection and medium for secondary-write semantics. Distinguish ordinary parameters, verified declared references, before/input data, pending after, and referenced stored records by resolved provenance and authority.

Implement the spelling correction independently of unresolved execution policy. Permitted secondary writes must stage through the same valid owner transaction. Acceptance proves revision invalidation, child/parent rollback, version/history/replay and rejection of forbidden snapshot writes, recursion or deletion. Existing ordinary parent-set tests do not establish hook behavior.

Cost: typed provenance plus staged secondary-write context.

### Exact integral literals in decimal positions

[INFERRED] Bucket c, high confidence. Interpret an integral source literal as an exact decimal when the expected type is uniquely decimal. Do not add general integer-variable coercion, ambiguous overload guessing or a JS Number intermediary.

Acceptance covers defaults, bounds, arguments, fixtures and emitted wire/schema values, including precision/range rejection and parsing without an inappropriate intermediate i64 limit.

Cost: a narrow contextual literal rule and ambiguity handling.

### Authoritative membership reads

[INFERRED] Bucket c, high confidence conditional on fencing. Distinguish deterministic value computation, bounded authoritative reads, mutation and external effects. Specify permitted contexts, snapshots, transitive effects and revalidation boundaries.

Acceptance proves revocation denies new access/spending, stale reads cannot authorize commits, failures stay visible and helpers cannot conceal writes/I/O. Preserve required accounting evidence without leaking content after revocation.

Cost: read/fence work and possible latency, to be measured.

## Runtime correspondence requirements

### Canonical generated execution

Dispatch intent and domain changes share the same fenced commit. Interim occurrence executors carry sibling `work.dispatch` rows through `effects.writes`; `originOccurrence` is stamped by the runtime and is null for direct calls. Generated producers preserve that association and atomicity when replacing an interim producer.

[INFERRED] High-confidence integration recommendation: migrate generated operations to the existing state engine, then retire migrated interim callers. Agree descriptors/ports, resolve emitted canonical identity, establish verified principal/team/owner/time, validate inputs, enforce accepted admission/evaluation order, use canonical queries/mutations/effects, commit required history/replay/work, and project results safely.

Acceptance includes denied access, stale versions, replay, failed business guards, disclosure, rollback and durable intents. Preserve delivered callable member linkage and artifact validation. Version descriptor compatibility explicitly.

### Forms and presentation

[INFERRED] High-confidence recommendation: derive real form descriptors from writable checked operation inputs. Join action/operation/mode/timezone/submit/identity metadata, bound arguments, create/update omission, versions, exact values, files, CSRF, full/partial context and error rerendering. Keep the approved complete presentation catalog.

Acceptance is a real generated form invoking the same operation as MCP with equal authority and consistent schemas.

### Selected receipts and observable progress

[INFERRED] High-confidence intent recommendation: implement the accepted shared relation over existing producers. The pure observation kernel remains a component; the public helper still needs checked locator authorization, selected leaves, nested progress and revision fencing.

Prove replaced associations reject stale business completion; status-only access reveals no protected request/result/locator; missing grants do not become ordinary authorized null; failed origin commits cause no provider call; dispatch guards yield defined skipped outcomes. For progress prove pre-ack correlation, duplicate/conflicting sequence, cancel-first tombstone, late usage, restart, terminal immutability, durable notification and visible handler-failure recovery.

Images require receiving-app finalized-file provenance, not only downloaded bytes.

### Executable examples and negative evidence

[INFERRED] High-confidence recommendation: extend existing loaders to actual emitted suites and production invocation. Validate fixture dependencies; provision distinct accounts/grants and real finalized test files; supply controlled provider fixtures; execute tables/sequences; compare independent expectations and persisted observations.

Setup errors, unavailable capabilities and expected business rejections remain separate. A rejected later sequence step retains earlier successful commits and adds no new domain/work effects. Assert compiled artifact identity. Altering an expected value, removing a call or suppressing a write must make the relevant test fail.

Recommend accept workflow intent for all 49 apps, subject to demonstrated site corrections and explicit scope decisions. Preserve runtime negatives; add deliberate compiler-negative fixtures where needed. Flip a file to reject intent only with explicit compile-negative purpose.

### Scoped fanout adoption

[INFERRED] Bucket d, medium confidence. Pursue a finite durable fanout contract and compare syntax only after guarantees are concrete. Define authoritative cohort/cutoff, stable source/record child IDs, concurrent change policy, checkpoint/admission atomicity, child authority, independent failure/retry, supersession and complete owner coverage. Keep ordinary bounded for overflow rejection.

Proof covers 499/500/501/1000 records, checkpoint crashes, duplicate source, concurrent insert/move/remove, rejected child, retry and supersession. An eventually updated owner directory is not proof of complete enumeration.

Flip evidence: a continuation design demonstrates equal completeness/recovery with lower complexity and authoring cost.


## Frontend composition requirements

Implicit forms include the complete source-derived input set, defaults, validation, corrected drafts and final authorization. Slot/cardinality inheritance and exclusive button bindings retain their owning declarations; a convenient renderer cannot broaden a binding or silently drop a required control. Calendars implement the actual date/range/navigation behavior. Whole-frontend redesign preserves the full application workflow, and desired-output companions faithfully express the intended source meaning without claiming unimplemented APIs. These requirements feed the existing source/UI and DFE outcomes in [REMAINING-WORK.md](REMAINING-WORK.md); the old lane launch prompts are retired.
