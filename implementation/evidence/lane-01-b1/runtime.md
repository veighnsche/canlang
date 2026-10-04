# B1 evidence — runtime consumption (closeout sprint)

Branch: `muse/closeout/runtime-b1`. Base: `origin/main` e93adeb.
Status: **B1 runtime half PROVEN** (compiled op + page + model consumed
by the lane-7 runtime path); three follow-ups filed below, none hidden.

## What this branch adds

Eight packets, integrated by the coordinator with seam fixes:

- P1 `packages/cloudflare/src/runtime/artifact.ts` — strict
  `loadArtifactFile` (artifact.ts shape, never silent).
- P2 `packages/cloudflare/src/runtime/modules.ts` — `assembleModules`:
  import rewrite (`@canlang/stdlib`→peer URL, `@canlang/ui`→built
  dist), sha-checked staging, fail-loud on missing producers.
- P3 `context.ts` + `stdlib.ts` — real `createContext`, interim
  data-plane stdlib (fenced StoragePort protocol, L3 handoff in header).
- P4 `runtime/invoke.ts` + `run` rewire in `cli/platform.ts` —
  `invokeCallable`, `can-platform run` executes load→assemble→envelope.
- P5 `packages/testkit/src/runner/loader.ts` — §13 `exampleFixtures`
  loader (normative `{fixtures,examples}` shape).
- P6 `packages/cloudflare/src/worker/assembly.ts` — `assembleWorker`:
  descriptor loading, `buildInvoker` bridge, entry delegation,
  INTERIM page dispatch (fail-closed), INTERIM_DDL (todo+note).
- P7 `.github/workflows/b1-join.yml` — CI builds the real values
  catalog, then proves b1_join PASSES (not skips) + CLI pins.
- P8 compiler gap-helper join — 5 lane-02 helpers
  (`add/subtract/multiply/negateDecimal`, `divideMoney`) + int mixes;
  7 new codegen tests, 321/321 green.

## Integration fixes by the coordinator (all verified, none silent)

- `@canlang/state` unresolvable from cloudflare → P3 imports moved to
  `@canlang/contracts` (verified definition site, all 11 names).
- P4 stdout human line → stderr (file contract: one JSON envelope).
- P6 sibling specifiers `./context.js`/`./invoke.js` → `../runtime/…`
  (was a guaranteed runtime throw); sibling mirrors swapped to the
  real landed imports; stale "pending" comments corrected.
- P1 `min_version >= 1` (copied from an e2e fixture) rejected the REAL
  compiler output (`canlang.builtins` 0) → `>= 0` per the contract's
  plain `number` + real producer; e2e reference untouched (lane-07
  owns it; divergence flagged).
- `require`/`hasRole`/`count` added to the interim stdlib as real
  semantics (guard assert, membership test with documented interim
  trust root, values-identical bigint count) — the emitted import set
  spans facade + interim and neither covered it; union filed for L3.
- `preferences` added to `HandlerContext` (emission reads
  `c.preferences.<App>`); `toBusinessError` preserves string/Error
  messages; invoke "has no export" distinguishes missing vs
  non-function exports.

## Proof transcript (all commands run 2026-10-05 ~01:15 CEST)

Real catalog: `packages/values catalog` → 59 entries, 15 features.
b1_join strict (no SKIP): `cargo test --test b1_join` → ok
(E6006=0/E6007=0/E6008=10, artifact shape valid).

```
$ can compile --format=json --catalog=…/catalog.json /tmp/lane01-b1/demo.can
COMPILE_EXIT=0   # 3 modules, 6 CRUD callables, 2 pages

$ node …/dist/cli/platform.js run --artifact /tmp/b1proof-artifact.json
artifact: 3 modules, 6 callables, 2 pages        # stderr
{"ok":true,"entry":"…/teamoffice.mjs","callables":[…6…],"pages":["/","/notes"]}
RUN_EXIT=0
```

Direct registry execution (`/tmp/b1proof-op.mjs`, real dist code,
spy store implementing the fenced protocol, labeled in-script):

- `canApp()` keys: `read,createTodo,updateTodo,deleteTodo,
  createNote,updateNote,deleteNote` — real emitted functions.
- `createNote(memberCtx,…)` → guard passed → commit batch with the
  exact row (`TeamNotes.Note`, `createdBy:"u1"`, data intact).
- `createNote(anonCtx,…)` → threw `"forbidden"` (fail-closed).
- `read["Note.read.1"]` → members `true`, anon `false`.
- `TeamNotesNotesPageDescriptor.admit(memberCtx)` → `{}`.
- `appDefinition.models` → `TeamTasks.Todo,TeamNotes.Note`.

## Filed follow-ups (the crisp B1 boundary, all fail-loud today)

1. **Artifact→registry linkage.** DESIGN 1075: exports are identity
   consts, implementations live in `canApp()`. The artifact carries
   no member pointer, so `invokeCallable` (written to a direct-export
   packet spec that contradicts 1075) reports e.g.
   `export "TeamNotes_create" is string, not a function` — pinned by
   a committed test. Fix: artifact member field or specified
   convention; runtime must not guess.
2. **Page render needs `PresentationContext`.** ui components take
   presentation ctx (preferredLocales, theme, path, CSRF…); emission
   passes the op ctx. CSRF minting is lane-6 — no interim token was
   faked. Needs the L1/L5/L6 context-construction decision.
3. **`await records` + form fields.** Codegen emits bare `records(`
   (async store, one-line fix + 3 golden pins — deferred, not
   hidden); `form Note.create` without `fields=` crashes ui forms
   (L1-vs-L5 default decision).

## Gates

- `cargo test`: 321/321 (incl. strict b1_join); fmt + clippy clean.
- root `vitest run`: 24 files / 201 tests green.
- `tsc -p tsconfig.check.json` + `tsc -p tests/e2e/tsconfig.json`: 0 errors.
- `can-platform run` exit 0 on the real artifact (above).
