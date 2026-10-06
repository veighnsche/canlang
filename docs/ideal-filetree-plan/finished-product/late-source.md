# Scoped source reconciliation

Initial semantic review `cf36983c768c32e0a63ac33c3b45a94dc75dc2d3`; refreshed structural catalog `5edc3bac2a341fbda0bb432649e90ba70d3c05db`. The initial nine-path delta is reread/reconciled without advancing complete checkpoint `8249342`. Earlier review pins retain their actual scope; changed source availability is superseded only as stated below.

## LATE-C3

HTTP op handler bundle, lazy default factory and assembly route now exist. Both HTTP/MCP consume common derived inputs/catalog/canonical invoker. Missing factory remains explicit interim501; auth/pages/limiter/upload/ingress default stubs still fail closed.

Supersedes: cf baseline blanket default HTTP operation route absence, only at source join scope

Remaining: Actual compiled installed producer/asset/auth/state/pages/upload closure, safe catalog/import error handling and browser/denied/restart journeys remain T19/T20/T21/FP.BROWSER/FP.INSTALLED-RELEASE gates. Factory import catches any import error; distinguish unavailable packaging from broken initialization before support qualification.

Required gates: T19, T20, T21, FP.BROWSER, FP.INSTALLED-RELEASE.

## LATE-DELIVERY

LoadedCanonicalDescriptors carries registry deliveryFields. Descriptor load retries once on IncompatibleArtifactError/unknown_input_kind and an error message containing quoted delivery, after stripping delivery input descriptors. Other predicates propagate; caller artifact is shallow-copied, not changed.

Inference: Temporary compatibility bridge, not receipt-runtime proof. Independent challenge: the message token can refer to input/operation named delivery rather than the rejected kind; the bounded second validation is the strongest countercase because remaining invalid kind still rejects. No admission bypass or exploit execution is claimed.

Remaining: Verify schema integrity and admission remains equally strict; actually compiled receipt/delivery-only operations; no fallback execution; remove bridge after owner loader tolerance/current matching producer.

Existing `interfaces/src/mcp/schemas.ts:722–823` validates delivery tags/required/default/array/description and duplicate names; `interfaces/src/http/operations.ts:429–446` preflights full descriptors before framing excludes delivery. Retain that single existing owner and verify every installed/direct producer uses the same validated lineage, including misleading message-name cases. No duplicate validator or malformed-artifact admission is claimed.

Required gates: T24, T25, T26, T32.

## LATE-TEST-SCOPE

New HTTP suite uses real interfaces handler dist and canonical seam with constructed Shop artifact/MemoryStorage and identity fixtures. Read positive create/echo/replay, session/CSRF, malformed/multipart/mismatch, receipt-only, sealed placement and JSON-pointer/HTML denial bodies. Rich per-kind pins indexed. Last conflict/ref test primarily cites earlier suite and exercises create; it does not independently execute all cited cases. t32b adds constructed OPS_SOURCE fixture handlers for create/update/archive netting and whole-set deliveryFields schema assertions. Deploy test asserts bundle markers/length; CLI timeout rises 5s to30s.

Remaining: These are source-inspected expectations, not executed evidence. Constructed artifact fixture cannot stand for all original compiled apps, installed workerd or actual D1. Character-length module count metric not universal raw Wasm-byte proof.

Required gates: T21, T22, T23, FP.QUALIFY, FP.INSTALLED-RELEASE.

## LATE-CONTEXT

New compiler B4-G report separates nonhook context availability: actor/now lower to c, team/operation lack IR lowering and can fall through as free variables. Hook wrappers have narrower carrier/bounds, requiring owner contract. Report options recommend explicit carrier or interim honest E6008; report itself changes no lowering. Independent source challenge confirms runtime HandlerContext/createContext and invoke builder provide caller/clock/store/memberships/preferences/canonical, without actor/now/team/operation. Compiler c.actor/c.now spellings therefore do not prove live values, either.

Inference: Required actor/now as well as operation.id and team-dependent workflow joins remain blocked unless the real source-derived verified runtime carriers are implemented. Nonhook c parameter evidence cannot establish property values or ambient hook context.

Remaining: Adopt owner-released per-scope verified actor/team/now/operation lowering and runtime carrier; compile and execute original required sites, preserve rejected context uses and readonly operation facts. No report option is silently implementation-approved.

Required gates: T04, T15, FP.CONTEXT.

[Exact hashes and path ledger](late-source.json); [independent source challenge](reviews/late-challenge-language.md). No test, build, install, deployment, provider call or source edit was performed. Active implementation records are evidence owned elsewhere, not acceptance imported by this audit.

A subsequent test-only merge `1f5c1b5` adds `packages/work/test/b3-mirror-conformance.test.ts` (902 lines). It is structurally catalogued and receives a separate independent [work-test review](reviews/late-work-tests.md). Production authority/ownership and receipt qualification gates remain unchanged; reported merge-owner suite counts are not audit execution.

The full test review retains narrow T25 locator/grant/retention/repoint/join source expectations. Root independently checked the claims and selected D/E/F assertion bodies: type pins are directional, progress is calculated without a completion commit, both read branches share actual observer/binders and omit enrolled fence. Full T26, actual durable/current authority/disposal and installed consumer proofs remain required; no defect or passing runtime result is inferred.

A final dispatch delta `5edc3ba` adds optional deployment availability before guard/revalidation/claim plus pure addressing/ordering fixtures. Root read all changed source and both test files; [independent dispatch review](reviews/late-dispatch.md) constrains actual target identity, durable terminal/transport mapping and updated port callback/profile scope. This supersedes only kernel source absence; no live serving, enrollment or terminal persistence proof follows from the fixtures.

The independent dispatch challenge found the concrete host gap: Cloudflare mirror omits availability/rejects `unavailable`; drive persists the held claim and awaits current snapshot/authority before replaying kernel callbacks. Kernel callback order and “no claim” tests therefore cannot certify physical host order. Bound-checked/live-server test titles exceed the direct manual staging/pure-observer assertions. Actual path carrier source→target is source-supported, while selected capability/resource alias binding and durable terminal error/receipt/no-redrive mapping stay owner-released integration gates.
