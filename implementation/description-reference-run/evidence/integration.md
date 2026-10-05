# D07 integration evidence — description/reference delivery

Writer: D07 integration verifier (supplemental lane). Revision: `1ea28ed`
(clean tree at start) + 1-line postbuild fix (see §6). Date: 2026-10-05.
Frozen producers were READ ONLY: `compiler/src/docs.rs`, `compiler/src/cli.rs`,
`compiler/src/ide/queries.rs`, `packages/interfaces/src/docs/reference.ts`,
`packages/cloudflare/src/cli/docs.ts`. No D02–D06 producer file was modified.

Lock protocol: every cargo/npm/bun/node/vitest run below held `.heavy-lock`
via `mkdir` (acquired, never held by sibling during this run), released with
`rmdir` after the last heavy command. No Git writes, no inbox/monitor/tasks edits.

E2E platform: the REAL installed producer
`node_modules/.bin/can-platform -> ../@canlang/cloudflare/dist/cli/platform.js`
(a workspace symlink to the freshly built dist; no shims, no stubs).
`can` = `compiler/target/debug/can` (`cargo build --bin can`, exit 0).
Catalog: `--catalog=packages/values/dist/catalog.json` (the documented flag;
fixtures live in `/tmp/d07-e2e`, outside the repo's catalog search paths).
`CAN_PLATFORM_BIN` was left unset for all e2e except the missing-runtime probe.

## 1. Suite matrix (all green, exact commands + exits)

| Suite | Command (cwd) | Result |
|---|---|---|
| compiler lib (incl. 16 cli) | `cargo test --test docs --test b4_parse --test b4_check --test ide --test exe --test codegen --lib` (compiler) | lib 81/0, b4_check 179/0, b4_parse 20/0, codegen 46/0, docs 12/0, exe 11/0, ide 31/0; exit 0 |
| interfaces full | `bun run build && node --test "dist/interfaces/test/**/*.test.js"` (packages/interfaces) | 318/0; exit 0 (re-run on final dist) |
| docs-reference subset | `node --test dist/interfaces/test/docs-reference.test.js` | 29/0; exit 0 |
| cloudflare cli | `npx vitest run packages/cloudflare/test/cli.test.ts` (root) | 16/16; exit 0 (re-run post-fix) |
| values | `bun run build && node --test "dist/values/test/**/*.test.js"` (packages/values) | 743/0; exit 0 |
| contracts | `npx vitest run packages/contracts` (root) | 3 files, 12/12; exit 0 |
| typechecks | `tsc --noEmit -p tsconfig.json` in values, contracts, interfaces, cloudflare | 4× exit 0, empty logs |

Total: 380 compiler + 318 interfaces + 743 values + 28 vitest = 1469 tests, 0 failures.

## 2. E2E `.can` → reference (exit codes observed, not inferred)

Fixture `/tmp/d07-e2e/shop.can` = docs.rs SHOP_SRC (model + contract, field/
param descriptions, `nl` variants, one `fr=null`, one `desc=""`, scenarios).
All runs: `can docs --catalog=$CAT [FLAGS] shop.can`, PATH prefixed with
`node_modules/.bin`.

| Case | Flags | Exit | Observed |
|---|---|---|---|
| en default | (none) | 0 | `# Internal declaration reference`, `Requested locale: en`, source prose, stable anchors (`#owner-shop`, `#decl-shop-gadget`, `#op-shop-restock`), version lines, `implementation status unknown` |
| nl | `--locale=nl` | 0 | `# Interne declaratie-referentie`, `Titel.`, `Gadgets te koop.` |
| case alias | `--locale=NL` | 0 | nl variant selected (`Titel.`) |
| regional | `--locale=nl-NL` | 0 | nl variant selected (`Titel.`) |
| null variant | `--locale=fr` | 0 | `fr=null` skipped → source `Display title.` |
| untranslated | `--locale=de`, `--locale=xx` | 0 | source fallback (`Gadgets for sale.`) |
| app default (nl) | `app Shop source="nl"`, no flag | 0 | `App default locale: nl`, Dutch headings without any flag |
| app default (en) | en app, no flag | 0 | `Requested locale: en` via app default (null-locale bridge path) |
| source-owner | nl-package message (`fr` variant only), app default en, `--locale=de` | 0 | requested+default both miss → nl source `Titel.` |
| empty source text | `alias:text desc=""` | 0 | empty cell (present, distinct from absent) |
| empty locale | `--locale=` | 2 | `error[E7001]: can docs --locale needs a non-empty BCP 47 tag` (truthful refusal, no silent default) |
| --out file | `--out=out-ref.md` | 0 | empty stdout (0 bytes), 2306-byte file, identical head |
| --out `.can` | `--out=evil.can` | 2 | `E7001` refusal; `evil.can` not created |
| --out input (literal) | `--out=input.txt input.txt` | 2 | `E7001 refuses to overwrite an input file` |
| --out input (canonical `./` spelling) | `--out=./input.txt input.txt` | 2 | `E7001 refuses to overwrite an input file` |
| broken source | `--out=broken-out.md broken.can` (`title:` → E1200) | 10 | `broken.can:3:18: error E1200 expected identifier`; `broken-out.md` NOT written |
| no operand | (none) | 2 | `E7001 expects at least one FILE.can operand` |
| missing runtime | `env -u CAN_PLATFORM_BIN PATH=/usr/bin:/bin` | 2 | `E7004: lane-7 producer 'can-platform' not found on PATH ... (see can explain E7004)` |
| determinism | `--locale=nl` twice | 0, 0 | identical sha256 `7ab2eba…9855` (also identical after the §6 rebuild) |
| escaping | `# <script>alert(1)</script> **bold** [x](y)` | 0 | `&lt;script&gt;alert\(1\)&lt;/script&gt; \*\*bold\*\* \[x\]\(y\)` |

Direct bridge probes (`can-platform docs`, same installed bin):

| Case | Exit | Observed |
|---|---|---|
| null locale (no flag, appDefault nl model) | 0 | Dutch render (app default, never ambient) |
| bad model version (`"version":99`) | 2 | stdout envelope `{"ok":false,"command":"docs","code":"invalid-reference-model","detail":"... unsupported version 99"}` + stderr human line |
| empty stdin | 2 | `invalid-reference-model` envelope (`empty reference model on stdin ...`) |
| invalid JSON (`{nope`) | 2 | `invalid-reference-model` envelope (JSON parse detail) |
| bad flag (`--bogus`) | 2 | shared usage text |

## 3. Source-language IDE hover + MCP source-string compatibility

IDE (suite `cargo test --test ide`, 31/0, exit 0): hover tests
`hover_shows_descriptions`, `hover_field_description_spellings`,
`hover_description_static_reference_resolves_wording`,
`hover_description_shows_source_language_only`,
`hover_param_description_from_slot`. No editor-locale feature: the only
"locale" hit in `compiler/src/ide/queries.rs` is the doc comment "no locale
selection" (queries.rs:865).

MCP compat — live `can compile --format=json` proof on
`/tmp/d07-e2e/mcp-compat.can` (attached `#`, legacy `@{desc}`, undescribed,
`desc=""`), exit 0:

- attached `#` → `"description":"Display title."` (source string)
- legacy `@{desc="Units in stock."}` → byte-identical member
  `"description":"Units in stock."` (raw-JSON grep, 2 occurrences)
- undescribed `plain` → member ABSENT (`'description' in field == False`)
- `desc=""` → present as `""` (absence-vs-empty distinct)
- `artifact_version: 1` (no migration)

Golden-shape tests (all in green codegen 46/0):
`d03_inline_param_desc_reaches_mcp_source`,
`d03_inline_field_variants_emit_source_only` (asserts no `De naam die klanten
zien.` leak + seam retains variant),
`d03_message_reference_resolves_to_source`,
`d03_attached_and_legacy_feed_same_slot` (byte-identical legacy member),
`d03_undescribed_inputs_omit_member`, `d03_empty_desc_stays_present`.
Ports stay plain-string: `packages/interfaces/src/ports.ts:167`
(`readonly description?: string`), `:194` (`readonly description: string`).

## 4. Retained negative controls

| Control | Probe | Result |
|---|---|---|
| duplicate `desc=` | `can check dup.can` (`desc="One." desc="Two."`) | E1202, exit 10 |
| duplicate `#` + `desc=` | `can check dup2.can` | E1202 `desc= cannot follow an attached # description`, exit 10 |
| checker-level slot dup | b4_check E3016 tests (in 179/0 suite) | green |
| variant repeats source lang | `app source="nl"` + `@{nl=...}` | E3016, exit 10 (correct; fixtures adjusted, not a bug) |
| unknown locale | `--locale=xx` e2e | exit 0, source fallback (not an error) |
| missing runtime | PATH without can-platform | E7004, exit 2, names `CAN_PLATFORM_BIN` + `E7004` |
| bad model version | `version:99` via bridge | exit-2 `invalid-reference-model` envelope (stdout + stderr) |

## 5. Deferred items verified ABSENT (check named for each)

1. Localized MCP — check: `grep -c locale packages/interfaces/src/ports.ts` → 0;
   descriptors typed plain `string` (ports.ts:167,194); D03 no-variant-leak
   asserts green. Not claimed anywhere.
2. AI-written guides — check: `grep -ci "guide|model-|llm|openai|anthropic"`
   over `compiler/src/docs.rs` + `interfaces/.../reference.ts` +
   `cloudflare/.../docs.ts` → 0/0/0. `can docs --help` promises a reference only.
3. Auto-translation — check: reference.ts imports `resolveVariant` ONLY from
   `@canlang/values` (selection, no generation); sole "translat" hit is the
   comment "(absent translation...)" (reference.ts:43). No translation engine.
4. Artifact migration — check: `ARTIFACT_VERSION = 1` (contracts/src/artifact.ts:14,
   "additive changes only"); live envelope `artifact_version: 1` (§3). No version bump.
5. Public publication — check: `can --help` lists 15 commands, none matching
   `publish|deploy-docs|host` (grep exit 1); `--out` writes a local file only.

## 6. Fresh-clone simulation + postbuild fix (reservation used)

Clean-rebuild-then-exec probe (need proven BEFORE any edit):

```
rm -rf packages/interfaces/dist packages/cloudflare/dist \
  packages/interfaces/tsconfig.tsbuildinfo packages/cloudflare/tsconfig.tsbuildinfo
# (tsbuildinfo is git-ignored; composite tsc emits nothing without removing it)
(cd packages/interfaces && bun run build)   # exit 0
(cd packages/cloudflare && bun run build)   # exit 0
ls -la dist/cli/platform.js                  # -rw-r--r-- (NO +x: tsc strips it)
can docs --catalog=$CAT shop.can             # exit 2:
#   error[E7004]: failed to exec lane-7 producer '.../can-platform': Permission denied (os error 13)
can-platform docs < model-v1.json            # exit 126: Permission denied (shell convention)
```

Need proven (exit 126 direct / E7004 e2e). Minimal fix — one line in
`packages/cloudflare/package.json` scripts (sole bin owner; no precedent):

```json
"postbuild": "chmod +x dist/cli/platform.js",
```

Re-proof after fix (zero manual chmod):

```
(cd packages/cloudflare && rm -rf dist tsconfig.tsbuildinfo && bun run build)
#   $ tsc -p tsconfig.json
#   $ chmod +x dist/cli/platform.js   <- postbuild auto-ran under bun
ls -la dist/cli/platform.js   # -rwxr-xr-x
can docs --catalog=$CAT shop.can            # exit 0, `# Internal declaration reference`
can docs --catalog=$CAT --locale=nl ...     # sha256 7ab2eba…9855 (identical to pre-rebuild)
npx vitest run packages/cloudflare/test/cli.test.ts  # 16/16
node --test dist/interfaces/test/docs-reference.test.js  # 29/29
node --test "dist/interfaces/test/**/*.test.js"          # 318/318
```

`package.json` re-validated as JSON; `bun.lock` untouched (scripts are not
locked); `git diff --stat` for the fix: 1 insertion, 0 deletions.

REPORTED (outside reservation, NOT fixed): the ROOT build path
(`tsc -b packages/cloudflare`, used by root `bun run build`) does not trigger
npm/bun `postbuild`. Verified: clean `npx tsc -b packages/cloudflare` emits
`dist/cli/platform.js` mode `-rw-r--r--` (exit 0), i.e. a fresh clone built
only via the root script still gets a non-executable bin. Fix belongs to the
root build wiring (lane-07/D08 scope), not to this one-line reservation.

## 7. Bugs found

Fixed in reservation (1):

- FRESH-CLONE-EXEC: tsc-emitted `dist/cli/platform.js` lacks +x, so fresh-clone
  `can docs` fails (E7004/exit 2; direct exec exit 126). Fixed by the §6
  postbuild line; re-proven with clean rebuild + full e2e + affected suites.

Reported, not fixed (1 limitation, outside reservation):

- ROOT-BUILD-SKIPS-POSTBUILD: `tsc -b` path emits 644 (§6, last paragraph).
  Recommends a root-build chmod step or equivalent in D08/lane-07 follow-up.

Investigated and CLOSED as correct-per-contract (not a bug):

- REQUESTED-EN-YIELDS-NL: `can-platform docs --locale=en` on a model with
  appDefault `nl` and an `nl`-only variant renders Dutch. This is the frozen
  whole-message fallback order (requested lookup → app-default lookup →
  source; source text is not an implicit variant), pinned by fixture
  'falls back to the app default when the request is untranslated'
  (docs-reference.test.ts:118) and implemented by the reused `resolveVariant`
  (values/src/locale.ts:67), not a second engine. Initial expectation was
  wrong; behavior matches the pinned contract.

No other integration bugs found. All D02–D06 producers behaved per their
frozen contracts; no producer file was touched.

## 8. Files released by this writer

1. NEW `implementation/description-reference-run/evidence/integration.md` (this file)
2. `packages/cloudflare/package.json` — postbuild scripts line ONLY (1 insertion)

Both released; zero other files written. Foreign concurrent edit noted but
untouched: `implementation/challenge-audit-run/monitor.md` (modified by
another writer during this run; coordinator/Codex-owned).
