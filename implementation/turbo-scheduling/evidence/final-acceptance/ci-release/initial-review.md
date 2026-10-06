# Independent CI/release acceptance review

Baseline: `7fd8c6bf4717feeffc70b46819377b74b353e117`; reviewed working bytes on 2026-10-06. No existing file changed by reviewer. This review independently read the root scripts, all 13 owner manifests, Turbo configuration, CI helpers, all 12 workflows, scheduling/developer docs, actual release/cache/root-test logs, and HEAD diffs.

## Required fixes before acceptance

1. **P1: automatic integration fails on a cold runner.** `.github/workflows/integration.yml:34` invokes root Vitest without an explicit preparation prerequisite or `CAN_PREPARATION_BIN`. `packages/cloudflare/test/preparation-protocol.test.ts:45` requires a live binary and throws when absent; ordinary TS builds neither build nor package the native prerequisite. The TS receipt helper already owns a correct isolated, pinned, locked debug prerequisite. Provision the same explicit prerequisite for integration and document the corresponding clean-developer setup. This does not authorize preparation release/adoption.
2. **P2: complete owning suites are missing from automatic joined acceptance.** Integration's root `bun run test` at line 35 uses `vitest.config.ts`'s four roots, excluding the ten package Node commands and emitted Cloudflare runtime command. Path-filtered lane jobs cannot qualify shared compiler/lock/config/producer changes, and no workflow invokes work-kernel conformance. Use the existing serialized `test:all` in unfiltered integration (with explicit native prerequisites), or equivalent complete coverage.
3. **P2: receipt verification fails open on omitted commands.** `.github/ci/verify-receipt.mjs:19-32` checks success only for submitted rows; it accepts an arbitrary one-command receipt missing install, versions, build, typecheck, tests, and tree cleanliness. `receipt-coverage-probe.log` reproduces acceptance. Require the complete selected-profile command plan with exact argv/order/CWD, frozen install and tool facts, and tests removing each required command. Retain existing failure/timeout/identity/checksum/native checks.

## Pin and determinism gaps in retained baseline profiles

- Node 24 is the documented verified runtime profile; lane-02 and state/stdlib runtime jobs retain Node22. Align the actual runtime CI profile or separately qualify Node22.
- `.github/workflows/lane-01.yml:61,82` uses TypeScript5.6.3; release editor line96 uses5.9.3. Lane01 editor Rust setup line83 leaves toolchain floating. Align declared editor/compiler pins. Root Bun1.4.2 and Turbo2.11.7 pins and strict task identities are consistent.
- B1 Cargo test/build lines70,76, lane01 Clippy line39, and work-kernel build:wasm omit `--locked`. Preserve native ownership and add frozen dependency resolution to these explicit commands.
- Release VSIX uses unpinned `npx @vscode/vsce` (line110). This is preexisting and should be pinned if editor release reproducibility is claimed.
- Integration's twice-executed uncached hash selects JS/declarations/maps only; CSS, WASM, JSON and modes are omitted. The independent cache verifier does compare full inventories and contains a genuine cache-disabled mutated-source rebuild. Broaden the integration inventory if its label claims full producer reproducibility.

## Verified and remaining scope

- CI helper tests: 13/13 pass, zero skips, Node24.21.0; raw log retained.
- YAML syntax: Ruby Psych parses all12 workflow files; raw log retained. This is syntax parsing, not GitHub/action semantic execution.
- Actual release log confirms13 cache hits plus13 uncached preparation executions, followed by3 executed stamp/manifest/verify tasks. Turbo declarations ensure all builds precede the stamp, then manifest, then verification; release workflow invokes this immediately before pack. Correct CWD derives from module path/root wrapper.
- Actual cache proof's full output inventories cover bytes/modes/extra outputs and upstream failure order; cache-disabled argument is `--cache=` and disables reads and writes. Native projects are explicit uncached adapters and retain Cargo ownership.
- Package/root tasks retain original test runner ownership and deliberate work/Cloudflare root CWD; suite concurrency1 is explicit for `test:all`.
- Hosted CI, Playwright/browser, editor packaging, native generation, alternate-host installed/native release/adoption were not executed by this reviewer. Native preparation release/adoption remains HOLD. No merge or publication occurred.

Initial disposition: request changes above, then re-review actual repaired bytes and focused evidence.
