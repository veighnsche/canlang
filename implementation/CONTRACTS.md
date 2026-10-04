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
