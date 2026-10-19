# Overlap inventory — duplicated code and behavior

Status: living audit record, opened 2026-10-19. Can's premise ([DESIGN.md](../specification/DESIGN.md)
§0 and implicit-behavior index) is one derived behavior per construct, "not optional
per-app implementation recipes." The language surface still honors that. The
implementation has accreted overlapping machinery anyway. This file is the canonical
list; each ID is one bounded removal unit. Dispositions: **remove** (safe dedup),
**decide** (needs a canonical-owner decision first), **keep** (intentional duality,
recorded so it is not re-flagged).

Evidence basis: multi-agent audit 2026-10-19 (partial; gaps listed at the end) plus
direct parent-session verification. Byte-identity claims were md5-checked.

## Literal duplicates

- **L1 | decide | per-package tsconfig drift.** `packages/{ui,identity,interfaces}/tsconfig.json`
  are byte-identical and extend `tsconfig.base.json` (correct shape). `packages/{work,files,services}/tsconfig.json`
  are byte-identical to each other but inline options WITHOUT extending the base, and the
  base is stricter (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `composite:true`, …).
  The second group never adopted the base. Canonical: `tsconfig.base.json`. Removal needs a
  decision (adopt base + fix fallout, or a shared relaxed base), not a mechanical swap.
- **L2 | REMOVED 2026-10-19 | identical playwright configs.** `tests/fixtures/{action-forms,action-gallery}/playwright.config.ts`
  were byte-identical. Shared settings now live in `tests/fixtures/playwright.fixture-config.ts`
  (`fixtureConfig(appDir)`); each dir keeps a 4-line entry point because testDir/outputDir resolve
  relative to the caller's location. Checks: `tsc -p tests/e2e/tsconfig.json` clean, both configs
  `--list` their own spec. (The prompt-pipeline config differs — devices/workspace settings — and stays.)
- **L3 | keep | one source in three places.** `packages/state/test/fixtures/numeric-control/source.can`
  is byte-identical to two dated docs snapshots (`docs/implementation/capability-roadmap-20261008/…`,
  `docs/implementation/compiler-completion/numeric-control-producer/…`). Docs copies are frozen
  evidence; state fixture is canonical. No removal; do not edit the frozen copies.
- **L4 | decide | "bad" fixture is not bad.** `packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-{bad,good}.descriptor.json`
  are byte-identical (403B). `packages/cloudflare/src/cli/platform.ts` requires `<stem>.descriptor.json`,
  so the file cannot simply be deleted; the fixture's badness must live in artifact/target/environment.
  Fix: make the bad descriptor actually invalid IF descriptor-level rejection is intended, else rename
  to a shared descriptor the test references for both stems.
- **L5 | keep | compiler tests mirrored into docs.** `compiler/tests/{bdd_checked_facts.rs,message_slot_coverage.rs,temporal_message_types.rs}`
  and `compiler/tests/fixtures/action-references/execute.mjs` appear as snapshots under
  `docs/implementation/compiler-completion/`. Frozen evidence; `compiler/tests` canonical.
- **L6 | REMOVED 2026-10-19 | native fixture sources in two test trees.**
  `compiler/tests/fixtures/native-{file-deferred,generation-receiving,guarded-email}.can` were
  byte-identical to `packages/cloudflare/test/fixtures/native-*.can`. Cloudflare side is canonical
  (matching the existing `native-read-boolean.can` precedent); the five compiler include sites now
  reference it. Checks: `native_generation_receiving` 7/7, `empty_file_value_inventory` 5/5,
  `native_guarded_send` 3/3, `send_guards` lib 6/6.

## Compiler duplicates and tiers

- **C1 | remove (blocked: active writers) | `reference_operand_type_id` twice.** Near-identical
  bodies at `compiler/src/analysis/scenario_disclosure.rs:1972` (method over `self.resolve.symbols`)
  and `compiler/src/codegen/scenario_receipts.rs:12280` (free fn over `ir.items`); only the lookup
  table differs. The nullable-`?` fix had to land in both. Canonical: one shared function over a
  lookup closure. Blocked until `scenario_receipts.rs` owner releases the file.
- **C2 | decide | tiered inventory preparation.** `FreshSourceContext::prepare` (strict),
  `prepare_queries` (tolerates E6007/E6008), `read_predicates::prepare_with_context` (full),
  `prepare_requires_with_context` (requires-only), plus per-consumer seal inconsistency: send guards
  (`compiler/src/codegen/send_guards.rs`) keep a strict whole-IR gate while membership and boolean
  bridges seal per-occurrence. Same inventory, different contents depending on which consumer asks
  and whether unrelated errors exist. Canonical direction: per-occurrence seals everywhere (the
  accepted CanCustomer-recover pattern); strict-gate consumers migrate one at a time.
- **C3 | remove | per-module syntax helpers.** `kids`, `name_text`, `tight_span`, `literal_string`,
  `object_entries`, `is_expression` are re-implemented privately in `compiler/src/ide/queries.rs`,
  `compiler/src/lint/rules.rs`, `compiler/src/analysis/{types.rs,effects.rs,examples.rs}`,
  `compiler/src/codegen/ir.rs` (3–5 copies each, signatures drift: text-based vs db-based `name_text`).
  Canonical: one home in `compiler/src/syntax/` (db-based forms) exposed `pub(crate)`; migrate call sites.

## Runtime/package mirrors and dual paths

- **M1 | decide | `distribution.ts` ×12.** Every `packages/*/src/distribution.ts` repeats the same
  `{modules: new URL('./', import.meta.url)}` shape with per-package extras (browser/bindings/catalog).
  Canonical: generate from the package manifest; keep only true per-package extras.
- **M2 | remove | `catalog.ts` ×6 hand-mirrored envelopes.** `packages/{files,services,state,ui,values,work}/src/catalog.ts`
  repeat a `{package,version,entries[]}` envelope; comments already defer to a shared envelope at the
  L1/L2 join, and `values` already imports one. Canonical: `@canlang/contracts` CatalogEnvelope.
- **M3 | decide | split work kernel.** `packages/work-kernel/src/{every,facts,lifecycle,linkage,receipt,recovery,retry,rows}.ts`
  vs `packages/work/src/kernel/*` and `packages/work/src/{receipt,recovery,schedule}/`: kernel concepts are
  name-mirrored across two packages without byte equality. Canonical: kernel facts in `work-kernel`,
  dispatch in `work`; needs an ownership ruling per concept before any merge.
- **M4 | REMOVED 2026-10-19 | census reserved-field mirror.** `FILE_CENSUS_RESERVED_FIELDS`
  (`packages/cloudflare/src/runtime/invoke.ts`) duplicated State's system-field guard set. State now owns
  one `SYSTEM_MANAGED_TOP_LEVEL_FIELDS` set (`packages/state/src/ports/file-reference-profile.ts`), used by
  its own guard and exported as `systemManagedTopLevelFields()` through `ports/index.ts` → state index;
  all three invoke.ts census skips load it through the existing producer channel (no static worker import,
  no bundle-boundary change). Checks: state file suites 52/0, cloudflare staging+owner suites 6/6.
- **M5 | decide | dual derive evaluation.** The same derives execute under reader-bound (evaluate) and
  reader-less (scenario) `c` contexts — the owner-hydration unit was forced to runtime hydration because
  emitted variants cannot be distinguished — and page-scope queries now also evaluate the compiled
  `derives` map per row at runtime (derived-columns unit). That is up to three evaluation paths for one
  semantics. Canonical direction: one derive evaluator with an explicit reader capability.
- **M6 | decide | hook invocation-only entries.** Hooks contribute `private_hook_invocation` entries to the
  operations artifact (`compiler/src/codegen/js.rs:17116`) solely for file/opaque inventory, while their real
  descriptors live in the hooks registry. Two representations of one callable. Canonical: inventory should
  consume the hooks registry directly.

## Intentional dualities (keep, recorded once)

- **T1 | keep | Values native/TS tiers.** `packages/values` routes `exact-route.ts` (`routeExact`/`NOT_ROUTED`)
  to a native accelerator with TS core fallback (`src/{int,array,wire,schema}.ts`, `src/internal/*-core.ts`).
  Semantics are owned by the TS core; removing either tier changes errors or perf. Not an overlap to merge.
- **T2 | keep | CST vs IR.** `compiler/src/syntax/cst.rs` (lossless source tree) → `compiler/src/codegen/ir.rs`
  (execution IR) → JS/artifact. Pipeline stages, not duplicates.
- **T3 | decide | Python parser.** `tools/can_parser.py` (~1350 lines, no symbol/type checking) re-implements
  `compiler/src/syntax/{parser.rs,lexer.rs}` and is referenced by `draft/` app docs and `tools/test_can_parser.py`.
  Either bless it as draft tooling (and state its drift) or retire it with its docs/tests.
- **T4 | keep | Values Wasm backend.** Native is the default; Wasm stays behind explicit `valuesWasm`
  selection. Fenced duality, no implicit switch.
- **T5 | decide | registry-only predicate fallback.** Predicate metadata can be served registry-only while the
  executable policy path is incomplete (recorded as intentional, not evidence of completeness). Close by
  finishing the executable path, then delete the fallback.

## Not yet audited (honest gaps)

- `compiler/src/codegen/ir.rs`/`js.rs` function-level dedupe beyond name counts (157 `or_else` in codegen;
  only tiered ones matter — C2).
- `compiler/src/codegen/scenario_*.rs` cross-module overlap beyond C1/C2 (filenames only so far).
- `packages/ui/src` vs `dev-server/src/ui.rs` body comparison; `draft/` app duplication.
- Runtime overlap in `packages/{state,work,interfaces,cloudflare}` beyond catalog/distribution (M1/M2).
- `dev-server/src/{artifact,compiler,runtime}.rs` vs `compiler/src/codegen/artifact.rs` content overlap
  (basename mirror only, unverified).

## Removal order

Safe first: L6 (done) → L2 → M4 → M2 → C3 → C1 (when released) → M6. Decisions before edits:
L1, L4, M1, M3, M5, C2, T3, T5. Every removal runs its affected suites once; close the item here
with checks + commit before opening the next.
