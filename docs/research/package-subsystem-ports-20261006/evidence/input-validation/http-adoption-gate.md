# V01.2 — Current bounded HTTP operation join assessment

Finite packet B, 2026-10-07; activation base
`c6896fd2dea782d8ed6412769337b76eb899ca53`. Static source contract refresh;
no build, workerd run, deployment, native port or source edit performed.
This supersedes the historical `bb479c2` assessment that the typed seam
was absent. Exact source hashes are in `current-ts.json`.

## Source verdict

The real `handleOperationRequest` exists in interfaces and is consumed by
`assembly.ts`'s `HttpJoin.createOperationHandler` (line 380),
`AssemblyDeps.http` (line 555), and `handleHttpOperationRequest` (1256+).
The bridge uses the same `buildInvoker`, identity store, clock and
artifact/derived catalog as MCP. Missing/nonfunction factory returns the
explicit interim 501 (1261–1267). The typed operation seam is implemented.

`worker/main.ts` declares the default sibling `./http-operations.js`,
loads its `handleOperationRequest` export, and wires the factory into
`AssemblyDeps.http` (528–555). `deploy/bundle.ts:663` builds the real
handler bundle; the deploy bundle includes `worker/http-operations.js`.
This is **source evidence for default operation wiring**, not evidence
that any currently running deployment contains it or that Rust ran.

The operation join covers `/api/operations/*` POST handling only. Its
assembly contract explicitly leaves auth/pages/uploads/ingress interim.
The old proposed whole `createHttpHandler` route-factory join exceeds
this consumed implementation; it is not a missing obligation of this
finite packet. `createHttpHandler` remains a real broader package handler.

## Framing and lineage contract

Actual handler order stays identity/session → body parse → route/body and
handle-mode rejection → redisplay snapshot → operation/inputs framing →
CSRF → operation ID → catalog shape → `_csrf` removal → closedness →
derived binding when present → credential liveness → invoker → response.
Unknown/missing/bound messages, own presence and order stay profile-owned;
no default fill or values normalization is added at interfaces framing.

`parseJsonBody` currently performs capped streaming, TextDecoder and host
JSON.parse; it has no private provenance record. A future success-only
owner producer hook can capture the exact raw root without changing
syntax/number/cap behavior. HTTP business-input stripping uses a new
spread object; owner-internal derivation must bind its exact root, without
sending a protected root/token through arbitrary injected invokers.
Forms retain JSON-or-string coercion/assignment semantics. MCP SDK args
have no demonstrated producer provenance. Neither shares HTTP lineage by
shape. See PH2/PH4 in `prepared-hook-review.md`.

## Distinct proof/release gates

| Claim | Current evidence | Remaining proof |
| --- | --- | --- |
| Real package handler | Source and existing handler/route test suites | No new execution claimed by B |
| Typed injection seam | Current assembly source; `http-operations-route.test.ts` names injected handler | Package route fixture is separate from default deployment |
| Default source wiring | main default sibling + deploy bundle builder | Exact produced/runtime bundle and deployment acceptance |
| Absent-factory fallback | Explicit assembly interim 501 branch | Preserve independently from supplied factory success |
| V08 native/package-workerd port | No new proof in this packet | Actual handler + real Wasm/adapter + workerd, including negative controls |
| Default Rust/deployed adoption | No new proof in this packet | Consumed native/profile releases plus verified default route/runtime proof |

Unit tests with an arbitrary injected invoker cannot establish canonical
bridge protection, source provenance, native execution or deployed
adoption. No missing-seam story or source-wiring-only native claim remains.

## Owner review

Codex state/interfaces acceptance of the consumed PH1–PH4 contract and
this narrow handler/seam assessment is pending. C04/cloudflare delivery
owners must review the exact future V08/default native join they consume;
B does not fabricate those ACKs or block unrelated direct V02 inputs.
