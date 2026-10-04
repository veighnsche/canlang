# Lane 01: Rust language, compiler and authoring tools

Status: active coordinator. B0 foundation in progress; no PRs merged yet.

Owner prompt: [lane 01](../prompts/01-language.md).
Workspace: `/Users/vince/Projects/canlang-worktrees/lane-01-language` (owned worktree, created 2026-10-04 from origin/main `b06d873`).
Branch prefix: `muse/lane-01-language/`; current branch `muse/lane-01-language/plan`.
Session: `01a10710-1445-7b80-bf93-f3d022adef03`. Native goal: `goal-01a10711-516e-7522-a9dc-ccec77252a20` (lane-01 full scope, no token budget).
Machine: 10 CPU, 17 GB RAM, 33 GiB free; start with at most 2 active implementation subagents.

## Current implementation evidence (2026-10-04, origin/main b06d873)

- `compiler/`: dependency-free scaffold only. `src/main.rs` (40 lines) prints help/version and rejects `compile|lint|fmt` as unimplemented. No lib target, no parser, no tests. `Cargo.toml` edition 2024, `publish=false`.
- `tools/can_parser.py` (1348 lines) + `tools/test_can_parser.py` (503 lines): Python syntax prototype. Parses core grammar to dict AST with start locations; known gaps recorded in GRAMMAR.md: `delivery(path)` type, sequence-form examples, preference ordering, CSV form import attrs, page `refresh`, structured derived-field labels, CRUD `expose`. Reuse as behavior reference, not a line port.
- `editors/vscode/`: TextMate grammar `syntaxes/can.tmLanguage.json` + `check-highlighting.cjs` + docs. No `src/` client, no LSP. Input to extend, not a second implementation.
- Corpus: `examples/TeamTasks.can`, `examples/ExpenseFlow.can`, 42 `draft/*.can` sources, 21 `draft/*.mjs` handwritten desired targets (witnesses, not implementations).
- Normative: `GRAMMAR.md` (fully read), `DESIGN.md` §13 (read; rest on demand per slice), `REQUIREMENTS.md` (surveyed), `DECISIONS.md` (consult per slice), `implementation/{PLAN,WORKFLOW,CONTRACTS,DIAGNOSTICS}.md` (read).
- Sibling lanes 02–07: not launched (status files untouched). No producer contracts exist yet; L1/L2 catalog-envelope join is pending L2 launch.
- No `packages/`, no `.github/workflows/` on main. Toolchain verified: cargo/rustc 1.99, node v24, gh 2.101.

## Consequential planning decisions (settled)

1. One crate `canlang-compiler` with lib + `can` bin; modules per PLAN tree. No workspace split until a real dependency boundary earns it.
2. Dependency-free Rust (no crates.io deps) for B0: hand-rolled JSON emit/parse, SHA-256, LSP stdio transport. Rationale: offline-capable builds, trivial CI, matches scaffold. Revisit only with measured justification.
3. Shared foundation is coordinator-written (slice 0) so parallel agents build on concrete types, not prose: `source.rs`, `diagnostic.rs`, `lib.rs`, `main.rs`.
4. Catalog envelope: L1 proposes the JSON envelope/version in slice 2 and records the L1/L2 join request; Rust consumes producer catalogs, never a hand-copied builtin table. Until L2 lands, checking uses an explicitly test-only catalog fixture.
5. Diagnostic codes: `E`/`W`/`I` + 4 digits. E1xxx syntax/layout, E2xxx names/imports/composition, E3xxx types/schemas, E4xxx effects/owners/disclosure/authority-shape, E5xxx operations/fixtures/examples, E6xxx codegen/artifact/capability, E7xxx tool/config. W1xxx unreachable, W2xxx shadowing (opt-in until precise), W3xxx deprecated. I1xxx unused/redundant/locale-fallback. `can explain CODE` serves this catalog.
6. Byte offsets (u32) canonical; `LineIndex` converts to LSP UTF-16. Language version string `"1.0"` provisional in JSON envelope `language_version`; schema_version starts at 1.
7. CST is lossless and recoverable: every source byte covered exactly once; `#`/`##`/blank trivia attached; error nodes + per-declaration recovery; typed spans on every node.

## Exact desired tree within ownership

```text
compiler/
  Cargo.toml Cargo.lock README.md .gitignore
  src/
    lib.rs main.rs cli.rs            # dispatch: compile/check/lint/fmt/explain/lsp (+ run/test/build/deploy thin entries)
    source.rs                        # SourceDb/SourceId/Span/LineIndex/SHA-256
    diagnostic.rs                    # Severity/Diagnostic/DiagnosticResult/JSON+text render
    syntax/{lexer.rs,layout.rs,cst.rs,parser.rs}
    analysis/{resolve.rs,types.rs,effects.rs,check.rs,catalog.rs}
    codegen/{ir.rs,js.rs,sourcemap.rs,artifact.rs,bdd.rs}
    lint/{rules.rs,driver.rs} format.rs ide/{queries.rs,tokens.rs,fixes.rs} lsp/{transport.rs,server.rs}
  tests/{foundation.rs,syntax.rs,analysis.rs,codegen.rs,authoring.rs}
  testdata/                          # corpus symlinks? no: small inline fixtures + paths into ../../examples,../../draft
editors/vscode/
  package.json (extend: activation, config, LSP client) src/extension.ts src/client.ts
  syntaxes/can.tmLanguage.json (extend as grammar coverage grows)
  README.md
packages/contracts/src/{artifact,diagnostic}.ts   # L1-owned; manifest/index assembly is L7
.github/workflows/lane-01.yml                    # cargo fmt/clippy/build/test + tsc shape check + ext check
implementation/status/lane-01.md                 # this file
```

Coordinator owns: `compiler/src/{lib,main,source,diagnostic}.rs`, `Cargo.toml/lock`, `tests/foundation.rs`, this status file, final wiring of every slice.
Never touched by lane 1: root `package.json`/lock/tsconfig (L7), `draft/*` sources (draft coordinator), producer catalogs (L2–L6).

## Interfaces and dependencies

Shared Rust types (slice 0, coordinator; agents consume, do not redefine):
- `SourceId(u32)`; `SourceDb::add(path,text)->SourceId`; `Source{path,text,sha256_hex}`; `Span{file,start,end}` (u32 bytes).
- `LineIndex::new(&str)`; `to_line_col(u32)->(line1,col1_bytes)`; `to_lsp(line0,utf16col)`; CRLF/LF; tab-in-indent rejected by lexer (E1xxx), never here.
- `Severity::{Error,Warning,Info}`; `Diagnostic{code:&'static str,severity,message,primary:Span,related:Vec<(Span,String)>,tags:Vec<String>}`; `DiagnosticResult{tool,tool_version,language_version,schema_version,sources[{id,path,sha256}],complete:bool,diagnostics(sorted by file,start,code),omitted:u32}`; `to_json()` deterministic key order, `to_text()` one-line-per-diagnostic `path:line:col: SEV CODE message`.
- CLI exit contract: 0 clean-or-warnings-only (or fmt-noop), 10 errors-reported, 2 tool failure. JSON always on stdout, progress on stderr. `--format=json|text` on check/lint/explain; `fmt --check` reports diffs, never applies.
- Fix contract (authoring): code action `{id,title,kind,safe:bool,edits:[{path,expected_sha256,range_bytes,new_text}]}`; stale hash rejects.

Producer/consumer joins:
- L2 values catalog (interface request IR-01 below): signatures feed `analysis/catalog.rs` + `can explain`; B1 needs one real signature end to end.
- L3–L6: invocation/commit, intent/file, presentation, identity/wire shapes flow into `artifact.ts` + codegen guards; L1 emits `capability` requirements, never implements them.
- L7: root workspace assembly for `packages/contracts` (IR-02); run/test/build/deploy thin entries delegate to lane-7 CLI (`can run|test|build|deploy` exec or print precise missing-producer error, never a second engine).
- Draft coordinator: corpus defects found while parsing `draft/*.can` go back as reports, not local edits.

## Subtasks, worker reservations and PR order

Slice 0 — coordinator, branch `.../plan`: status plan + `source.rs`/`diagnostic.rs`/`lib.rs`/`main.rs` + `tests/foundation.rs` + `lane-01.yml` + `packages/contracts/src/{artifact,diagnostic}.ts` → PR1 `B0 foundation`. Acceptance: `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `tsc --noEmit` on the two contract files, `can --help`/`--version` still work.
Slice 1 — agent SYNTAX (reserved: `compiler/src/syntax/*`, `compiler/tests/syntax.rs`): lexer+layout+CST+recoverable parser for full GRAMMAR.md incl. recorded prototype gaps; golden tests over `examples/*.can` + all `draft/*.can` (parse ok-or-report; corpus defects reported, not fixed); unit tests for layout edge cases (one-space indent, CRLF, `@{...}`, `#=` refs, semicolon leaves, query tails). → PR2.
Slice 2 — agent AUTHOR (reserved: `compiler/src/{cli,lint,format,ide,lsp}/*`, `compiler/tests/authoring.rs`, `editors/vscode/src/*`, `editors/vscode/package.json`): CLI dispatch + `explain` catalog + JSON/text surfaces; idempotent formatter on CST (preserves `#`/`##`/i18n/order); lint driver + first rules; LSP stdio server (diagnostics/completion/hover/definition/refs/rename/tokens/actions) sharing analysis; VSCode client extension. Needs CST read access (read-only) after slice 1; starts with CLI/explain/LSP-transport/vscode-scaffold against slice-0 types. → PR3.
Slice 3 — coordinator+review: analysis (`analysis/*`, `tests/analysis.rs`): resolve/types/effects/check + catalog consumer + precise errors; may delegate as agent ANALYZE once SYNTAX lands. → PR4.
Slice 4 — agent EMIT (reserved: `compiler/src/codegen/*`, `compiler/tests/codegen.rs`; read-only on analysis IR): checked IR + direct JS emission per DESIGN §13 (appDefinition, callable registry, guard/effect order, UI calls, page descriptors, BigInt/exact scalars, `message()`/`exampleFixtures()` shapes), source maps, separate BDD artifacts, unavailable-capability errors. Test-only golden artifacts until runtime joins. → PR5.
Then B1: one real L2 signature through check; one compiled model/operation/page consumed by runtime (L7-coordinated); CLI/LSP agreement test on a deliberate error; formatter idempotence + agent-JSON determinism gates. Continue through B2–B5 per PLAN.

Agent rules (all): one owned worktree, disjoint exact files above, no git/stage/commit/branch/worktree commands; read GRAMMAR.md + relevant DESIGN sections first; long commands `yield_time_ms:120000`, routine rechecks 1–5 min default 2; report evidence + residual gaps, never mock-backed completion.

## Reused packages and qualification

- `tools/can_parser.py`: behavior oracle for syntax edge cases; qualify by porting its 503-line test expectations to Rust golden tests. Not a runtime dependency.
- `can.tmLanguage.json`: extend scopes for new constructs; qualify with existing `check-highlighting.cjs`.
- DESIGN §13 draft `.mjs` targets: emission oracles; qualify per-construct correspondence, flag drift to draft owner.
- Rejected: rowan/tree-sitter/syn (second grammar owner), serde/clap/tokio/tower-lsp (dependency weight unjustified at B0), new npm deps for the extension until LSP API settles (then `vscode-languageclient` only, via L7 root if needed).

## Test cases (acceptance, cumulative)

- T1 foundation: line index CRLF/unicode; SHA-256 known vectors; JSON envelope determinism (byte-identical reruns); exit codes 0/10/2.
- T2 syntax: all corpus files parse with documented outcome; invalid layout/tab/CR/CRLF-mix, bad indent, `#=` misuse, unknown attribute, `a<b<c`, `??`+`and` mixing, empty import group each yield precise E1xxx with span; recovery yields ≥2 diagnostics on multi-error file without cascade.
- T3 analysis: unknown symbol suppresses derivatives; nullable/array misuse; `!` marker rules; shadowing/migration/type fixtures; catalog-missing builtin → precise error naming producer.
- T4 emission: TeamTasks emits `appDefinition`+registry+pages importing only `@canlang/stdlib|ui` + declared bindings; guard/effect order preserved; source map maps emitted lines to `.can` spans; BDD artifact separate; formatting idempotent (`fmt(fmt(x))==fmt(x)`, `#`/`##`/i18n/order preserved).
- T5 authoring: CLI and LSP report the same deliberate error with identical span; agent JSON stable across reruns; stale fix (wrong sha) rejected; `explain` round-trips every emitted code.
- T6 integration (B1): real L2 signature checked + emitted; compiled artifact consumed by local runtime; denied/stale/replay cases flow through compiled handlers.

## Progress and file reservations

- 2026-10-04: worktree + goal created; plan written. Reserved: coordinator `compiler/src/{lib,main,source,diagnostic}.rs`, `compiler/tests/foundation.rs`, `.github/workflows/lane-01.yml`, `packages/contracts/src/{artifact,diagnostic}.ts`, this file. Free: `syntax/*`, `analysis/*`, `codegen/*`, `{cli,lint,format,ide,lsp}/*`, `editors/vscode/src/*`.
- 2026-10-04: slice 1 SYNTAX done (agent): `syntax/{lexer,layout,cst,parser,mod}.rs` + `tests/syntax.rs`; 23 lib + 36 integration tests, 44/44 corpus clean, clippy/fmt clean. Coordinator wired `pub mod syntax`, verified all 90 tests green.
- 2026-10-04: slice 2a AUTHOR done (agent): `cli.rs`, `explain.rs`, `lsp/*`, `tests/authoring.rs` (27 tests, wiring shim to remove), `editors/vscode/src/*` + package.json/README. Verified green; wiring + PR3 after PR2 merges.
- 2026-10-04: main advanced e204d07→f5f2b5e (16 lane merges). GRAMMAR/DESIGN unchanged; no main changes under compiler/editors/vscode/lane-01 files. Branch rebased via checkout -B; full suite re-verified green. IR-02 SATISFIED: L7 index.ts re-exports artifact+diagnostic. L2 catalog live (50+ entries, adopted IR-01 sketch) — analysis slice can consume it.

## Interface requests and handoffs

- IR-01 (to lane 02, needed B0/B1): versioned builtin-catalog JSON envelope proposal — L1 will propose `{catalog_version, language_version, entries:[{id,owner,kind,signature,effects,availability,deprecation?}]}` with exact-value tags surviving transport (no bare BigInt/Number collapse). Awaiting L2 launch; B0 uses explicitly test-only fixture.
- IR-02 (to lane 07, needed B0): assemble `packages/contracts` (`package.json`, `src/index.ts` re-exporting L1's `artifact.ts`+`diagnostic.ts`) in root workspace. Awaiting L7 launch; B0 verifies the two files standalone with `tsc --noEmit`.
- IR-03 (to lane 07, needed B1): `can run|test|build|deploy` delegation target (binary name/args) so thin entries exec correctly.

## PR and verification evidence

- PR1 https://github.com/veighnsche/canlang/pull/2 (merged 2026-10-04 as `e204d07`): slice-0 foundation. Branch `muse/lane-01-language/plan`, reviewed head `85c9dae` (2 commits incl. review fixes), squash-merged with `--match-head-commit`. Checks: lane-01 rust/contracts/editor all SUCCESS (push + PR runs); local `cargo test` 12 passed, clippy `-D warnings` clean, fmt clean, tsc strict clean. Independent read-only subagent review: 2 material CRLF location findings + 4 nits, all fixed and re-verified before merge. Residual: binary still scaffold-only; no parser/analysis/emission.
- PR2 https://github.com/veighnsche/canlang/pull/30 (merged 2026-10-04 as `bc008f7`): slice-1 syntax. Branch `muse/lane-01-language/syntax`, reviewed head `d055065`, squash-merged with `--match-head-commit`. Checks: lane-01 rust/contracts/editor + L7 tools/workspace all SUCCESS. Local: 23 lib + 43 syntax tests (44/44 corpus), clippy/fmt clean. Independent review: 2 blocker panics + 4 material + 4 nits, all fixed with regression tests (coordinator confirmed one panic pre-fix, E1006 post-fix).
- IR-03 SATISFIED 2026-10-04: L7 PR #21 ships `can-platform <run|test|build|deploy> --artifact <path> [--env]` (JSON envelope, exit 0/2/1); L1 thin entries exec `can-platform {cmd}` with verbatim passthrough, confirmed live against a fixture binary.
- Exit-10 semantics settled: exit 10 = errors reported; warnings alone exit 0 (DIAGNOSTICS.md: warnings never block). Enforced by `cli_check_like_commands_exit_10_on_errors` via a `dispatch_with` analyzer seam.
- Follow-up for analysis slice: `SourceDb` compaction API (LSP re-adds full text per distinct edit; identical-text no-ops already skip).

## Remaining work and cleanup

Full lane scope per prompt. Worktree `/Users/vince/Projects/canlang-worktrees/lane-01-language` owned by this coordinator; cleanup only after all writers/viewers release. Risks: L2/L7 unlaunched (catalog + workspace joins pending — mitigated by test-only fixtures, no blocked idle time); GRAMMAR↔DESIGN drift on draft extensions (resolve via draft owner + JEV three-rewrite where consequential); scope creep into platform engine (guard: thin entries only).
