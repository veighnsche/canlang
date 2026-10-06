# V01.1 — Input-validation caller contracts and workload registry

Task: V01.1 (lane `V-evidence`, wave 1, after `C01.ready`). Produced
2026-10-06T08:33:31Z by lane F session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9.
Planning record only; no implementation authorized.

- Planning checkpoint: `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5`
- Inventory head: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06` (current main)
- Basis: `scope.json` (C01.1) — values/interfaces byte-identical
  checkpoint-to-head; state delta (bb479c2) is authorization-only and does
  not change validation entry shapes. Companion files: `caller-inventory.json`
  (callers per entry/mode), `current-ts.json` (baseline hashes + signatures).
- No full-port claim: a parser-owned port is not completion of the legacy
  validator port. Public arbitrary-`unknown` entries and hand-built schemas
  remain fully legacy TS (see `legacy-ts` profile).

## Admitted domains per profile

| Profile | Admitted domain | Explicitly excluded (stays legacy TS) |
| --- | --- | --- |
| `values/v1` | Owned ordered plans over parser-owned data: values check/normalize/optional encode; registered-plan inputs with resolved dispatch, bounds, defaults | Arbitrary `unknown` values; accessors/proxies/cycles/sparse arrays/symbols/custom prototypes/`toJSON`/getters; hand-built `NormalizedSchema` even when structurally accepted |
| `http-input/v1` | Whole HTTP JSON framing+binding over owned parser lineage (`parseJsonBody` capped reader + provenance at creation); form JSON-or-string coercion stays host-parsed | Form fallback semantics (legacy until V10 faithful producer); HTTP string/boolean value checks (deferred to state); manufactured defaults/schema from missing metadata |
| `mcp-ordinary/v1` | Ordinary-mode MCP read/mutation ref framing + derived binding over owned inputs, after host mutation-ID framing and closedness checks | Handle-mode/sealed handles (separate TS orchestration); SDK argument provenance (must be proved first); query `operation_id` (unknown business member) |
| `state-generated/v1` | Generated-state check + ordinary-array fill + ref extraction at the existing post-replay/age/auth validation point, over proven producer data | Interim identity paths; loader-derived channels retained by state owner; model-pipeline/emitted-callable defaults; receipt replay/hash (TS, position frozen) |
| `legacy-ts` | Everything else: all unproven unknown inputs, structurally accepted schemas/descriptors, forms, SDK objects without producer evidence | (this profile IS the exclusion domain; no migration advertised) |

## Error / order / identity obligations per profile

- `values/v1`: accumulate violations in current order; undefined-valued
  unknown keys ignored, undefined known values count as omission;
  required/nullability/create/update/explicit-default rules; nullable-array
  precedence; engine fields; trim after decode before bounds; inclusive
  bounds; complete union/array elements; recursive mutation refs; secret
  refusal; unknown-field vs unknown-argument; canonical wire errors; frozen
  outputs; shared-default and empty-array host-registry identity.
- `http-input/v1`: first unknown in JS enumeration order, then first missing
  required in shape order (own presence), then first bound failure in derived
  input order. Explicit own null/undefined differs from values. No
  normalization/default fill — return submitted raw business inputs.
  Catalog-without-derived framing-only behavior kept. Interfaces
  digits-only versions admit zero/leading zeros/arbitrary magnitude.
- `mcp-ordinary/v1`: host mutation-ID framing first; closedness precedes
  descriptor ref-shape checks, which precede derived binding. Nullable ref
  deferral only for members present in derived declarations. Ref parsers
  reject extras; ID UTF-16 `.length <= 256`. Failures project to
  `McpError(InvalidParams)` at the host. HTTP bound refs keep their
  different permissiveness.
- `state-generated/v1`: aggregate unknown/required/array/ref/version errors
  in current order; presence-only generated scalars; fill only absent
  optional ordinary arrays; preserve explicit null and present-undefined
  behavior; ignore operation defaults; extra ref-member permissiveness;
  strict state version domain `/^[1-9][0-9]{0,14}$/`; ordered refs with
  safe-number version conversion; normal shallow copy (unfrozen).
- `legacy-ts`: preserve read/`ownKeys`/get/exception traces, `toJSON`,
  sparse/cyclic behavior, and existing identity on every retained path.

## Consumer modes (distinguished, not unified)

- **Deployed MCP**: real factory path — `AssemblyDeps.mcp.createHandler`
  injected by the deploy join into `worker/assembly.ts` (`POST /mcp` served
  once joined). Does NOT resolve SDK argument provenance.
- **HTTP 501**: interim dispatcher — known operation routes return explicit
  interim 501 naming the interfaces join (`worker/assembly.ts`); mutations/
  auth are 501 until the bounded existing-handler join lands. V08 proves the
  port with the actual handler + workerd fixture; default deployed adoption
  stays gated. Completing unit tests against an injected invoker proves
  nothing about deployment.
- **Forms**: `packages/ui` generated forms (`projectGeneratedInputs`) plus
  `parseFormBody` coercion — fully legacy TS until V10 declares a faithful
  producer. Current form assignment behavior is not silently fixed by the
  lineage mechanism.
- **Handle mode**: sealed handles (`contracts/src/wire.ts`,
  `presentation.ts`; `interfaces/src/http/operations.ts`, `mcp/schemas.ts`,
  `mcp/server.ts`) — separate TS orchestration; outside owned-input scope.

## Workload registry (initial nominations; budgets ratified at V01.2+)

1. HTTP JSON framing+binding whole calls (caller-typical + maximal bodies
   up to the 1 MiB cap): first-unknown/first-missing/first-bound traces.
2. Values whole-call check/normalize/optional-encode over owned plans:
   wide/decimal/temporal matrices plus legacy-trace parity set.
3. MCP ordinary read/mutation ref framing + binding: closedness/ref-shape/
   derived-binding traces with deferral cases.
4. State generated check + array-fill + ref extraction at the post-replay
   validation point: aggregate-error traces, version-domain edges.
5. Negative corpus: forged tokens/tags/handles, mutated plans, over-budget
   registrations, malformed/truncated inputs — all must fail closed with
   adapter-construction errors before execution.

## Owner review status

Required (recorded, not assumed): values owner (numeric/raw/carrier
contracts + codec reuse), validation owner (plan/traversal/profile split),
interfaces owner (HTTP/MCP order, messages, provenance production), state
owner (admission point, replay/hash freeze, array-fill/copy semantics),
C04 delivery owner (Worker backend prerequisite). Each admitted domain,
error/order/identity obligation, and consumer above needs its owner's
review before its plan's V02 extraction begins.
