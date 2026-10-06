# Final CI, release and documentation acceptance

2026-10-06; main `7fd8c6bf4717feeffc70b46819377b74b353e117` plus unmerged working changes. Implementation and local verification are complete; the [independent migration review](migration/README.md) records the final acceptance verdict. This covers the package/Bun/Turbo build migration and its CI, artifact and documentation cutover. Broader product acceptance remains separate.

## Implemented corrections

Bun's isolated linker is explicit and participates in Turbo's global inputs. CI uses Node 24, Bun 1.4.2, TypeScript 5.9.3 and pinned Rust 1.99.0. Integration executes every retained package/runtime and root suite, generates the catalog before its fixture, and supplies a fresh private locked native preparation test prerequisite. Browser CI builds the explicit uncached compiler prerequisite and watches package, compiler and shared tooling changes.

The receipt runner and verifier share required ordered command plans. Success authenticates every required command, source/tool fact, positive executed test count, safe unique log and applicable native fact. Arbitrary incomplete receipts now reject. Existing hosted run/job/attempt/artifact checks remain.

`bun run release` builds and validates; `bun run release:pack` additionally packs all 13 workspace owners, including private dependencies, after uncached validation. Artifact manifests retain names, versions, private flags, hashes, sizes and internal dependency rewrites/runtime closures. Packing disables lifecycle scripts and does not publish. Active developer/package documentation matches public scheduling commands and explicit native prerequisites.

## Actual local results

[Command record](verification.json), [raw logs](commands/) and [final executable/configuration pins](source-pins.json) distinguish this run from earlier historical proof. Profile: macOS arm64, Node 24.21.0, Bun 1.4.2, Turbo 2.11.7, TypeScript 5.9.3, Rust 1.99.0.

| Check | Result |
| --- | --- |
| Frozen install / build | Explicit isolated install without lock change; 26 successful producer/preparation tasks. |
| Workspace / e2e typecheck | 40 / 27 successful tasks. |
| Complete retained test graph | 38 successful tasks; 636 root plus 4,905 owning package/runtime tests = **5,541 passed**, zero failures/skips. |
| Boundary guard / negatives | 13 owners, 681 files, zero violations; all 12 controls pass. The 576 runtime/context expressions retain explicit audit limits. |
| Receipt/gate tests | All 32 pass, including omitted/reordered/changed commands, forged counts, source/tool identities, safe logs and native facts. |
| Installed declarations | All 13 owners and 150 typed exports; zero Can/consumer diagnostics and undeclared owned imports. Missing/corrupt declarations reject the actual gate; restoration recovers baseline. |
| Installed Worker/assets | Cloudflare-only direct isolated tarball consumer; production workerd/D1 reaches expected auth 401; selected CompiledWasm passes ABI 1 and add-int(1,2) = 3. Missing/corrupt WASM/CSS reject. |
| Release packing | 30 successful tasks; all 13 tarballs and complete internal runtime closure. A second consumer verifies and installs those **exact release artifacts**, then passes Worker/asset checks. |
| Existing reproducibility gate | Two actual cache-read/write-disabled builds match all 2,229 JS/declaration/map files. |
| Refreshed full cache proof | 17 actual phases and 15 probes pass; restoration matches all 2,242 files, 18,165,975 bytes, SHA-256 values and modes. Deletion/rollback, CLI `0755`, ownership exclusions and actual failed-producer blocking pass. |
| Native/editor prerequisites | Cold locked private preparation debug build; uncached locked compiler build; two B1 joins pass; pinned editor typecheck/CommonJS emit and real compiler LSP checks pass. |
| Browser inventory | 44 Playwright tests discovered in 10 files; journeys were not executed. |

[Fresh cache evidence](cache/report.json) retains raw summaries and the complete 1,181-file working-byte [snapshot](cache/snapshot.json). Host/tool/environment invalidation remains dry-hash evidence; alternative platforms/toolchains and native cached builds are not executed. The local TS cache remains the only accepted cache family.

The parent [installed-type replay](installed-types/evidence.json) and [type review](types/README.md) preserve the canonical ownership gate and controls. [Installed Worker replay](installed-worker/evidence.json), [release manifest](ci-release/release-artifact-manifest.json), [exact artifact-consumer report](ci-release/artifact-consumer-probe.result.json) and its [raw logs](ci-release/artifact-consumer-raw/) identify actual producer and packed bytes.

## Independent acceptance and limits

[Independent CI review](ci-review/README.md) passes 79 static checks across 12 parsed workflows, actual dry graphs and receipt plans. It discovered the missing browser compiler prerequisite, now fixed. [Independent migration acceptance](migration/README.md) reviews final source pins, complete inventories/snapshot, retained test sets, installed declarations/Worker, exact artifact closure and documentation. Earlier findings and unsuccessful attempts remain historical evidence.

Strict installed compilation uses `skipLibCheck: false` and preserves **797 diagnostics in Miniflare 4.20260730.0 declarations**. The accepted gate covers Can declarations and consumer imports; whole-program strict vendor library checking does not pass. No vendor patch, dependency change or skip workaround hides this limitation.

Node permissions deny checkout reads only for the verifier child; Bun/workerd children do not inherit them. Installed producer realpaths and emitted runtime bytes are checked separately. No hosted workflows/receipts, full browser journeys, VSIX packaging, native/Wasm regeneration or alternate-host release qualification was newly executed. Remote caching, missing receipt/work producers and original native/product/installed-host gates remain open. Native preparation release/adoption stays held. No merge/publication occurred; the complete living-plan checkpoint is unchanged.

For the exact payload probe, run `bun run release:pack` followed by `node implementation/turbo-scheduling/evidence/final-acceptance/ci-release/artifact-consumer-probe.mjs` under the accepted Node/Bun profile. The probe only verifies and installs current tarballs in a fresh scratch consumer; it never builds or repacks them.
