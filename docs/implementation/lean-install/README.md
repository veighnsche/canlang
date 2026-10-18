# Standalone installation and dependency audit — 2026-10-15

Owner: standalone release assembly (`scripts/{build-install,pack-install,verify-install}.mjs`), consuming existing compiler/package owners. Accepted scope: one command installs matching prebuilt tools; an external application can check, compile, build, execute inline examples and start a protected preview without manual runtime dependencies. Browser automation is explicitly separate opt-in development tooling. Report actual download, file and allocated bytes. Public hosting and authenticated deployment remain release/account gates.

## Production shipping closure

| Ship | Reason |
| --- | --- |
| Release compiler and matching Values catalog | Authoring, compiler, LSP; no Rust installation needed |
| Production Can JavaScript, package/export metadata, Values WASM/glue and integrity declarations | File-based runtime resolution, source emission and schema/value semantics |
| Built browser-facing app assets, grammar, linked help and two catalog metadata files | Preview UI and revision-bound authoring inputs; these are not a browser executable |
| Private Node 24.22.0 and shared esbuild 0.28.1 | Node host, detached IPC, Worker orchestration and all four dynamic bundle paths; Bun is not shipped |
| Required third-party packages, host workerd and Sharp native packages | Actual Worker execution, parsing and asset processing |
| Testkit's inline-example runtime | Ordinary inline examples execute on the local engine without Playwright |
| Wrangler 4.116.0 and production closure | Deployment CLI; shares existing workerd/Miniflare versions |
| License/notice inputs | Preserve compiler and packaged dependency attribution |

**Excluded:** Bun, Chrome/Chromium, Playwright and its three packages, TypeScript compiler, Turbo, Vitest, happy-dom, work-kernel, contributor build trees, emitted Can tests, most declarations/maps, research, editor extension and the unused native preparation helper. Values integrity declarations, executable Interfaces docs and Wrangler TypeScript templates remain required. Keep runtime files according to use, not directory names. Omit the redundant `workerd/bin/workerd` hardlink copy: 114,566,712 duplicate bytes saved on this Mac.

The assembler follows dependencies, host optional dependencies and nonoptional peers, never devDependencies. Conflicting versions have nested destinations; resolved version edges are checked. The archive is link-free. Package metadata drops development declarations and install scripts. Forbidden browser/contributor packages cause assembly to fail.

`bun run check:dependencies` enforces import ownership and production/development declarations across 13 packages (1,276 source files, zero violations at qualification). Runtime imports cannot rely on devDependencies. Tests/tooling declare their direct dependencies, including previously hoisted imports. Playwright moved from Testkit optionalDependencies to devDependencies: optional production dependencies can still be installed. Contracts' optional type-only browser peer does not add a package to the core archive. Existing full path-boundary findings are not represented as fixed.

## Separate browser development installation

The user selected a separate opt-in installer. After core installation:

```sh
sh output/install/install-browser-tools.sh
```

This uses the core's private Node runtime to install a pinned development manifest and lock under `~/.local/share/can/development/browser/1.63.0`. Its devDependencies contain `@playwright/test` 1.63.0. It reads the existing lock as constrained data, verifies SHA-512 before extracting the three packages, and runs no package scripts. It does not execute Bun or npm. Only this explicit command downloads Chromium headless shell and ffmpeg. The installer/manifest/lock are sidecars, never members of the production tarball. An explicit `CAN_BROWSER_TOOLS_ROOT` selects another separate installation.

Public releases publish those three sidecars in the separate `can-browser-development-tools-VERSION.tar.gz` archive with a SHA-256 checksum. Extracting it preserves the installer's adjacent `browser-development` inputs. Publication checks both hosts' optional archives against the tagged installer, manifest and lock before publishing either core archive.

Browser discovery does not download anything. Required browser acceptance fails with actionable instructions if the add-on is missing, even if a surrounding checkout has hoisted Playwright. Core preview and inline examples work without it. The narrow Node module hook permits external Playwright config/worker imports from the selected development root; valid app-local imports take precedence and broken local packages do not silently change producer.

## Installed behavior

The launcher resolves its private installation through public symlinks and supplies catalog, compiler, platform/dev adapter and help defaults. There is no production browser path. App-local Testkit takes precedence; exact absence falls back to shipped inline tooling.

Prebuilt captures use shipped outputs and catalog metadata instead of contributor timestamps. Nested dependency copies have distinct capture identities. Generated candidate acceptance is confined below the application's canonical root. Existing source checkout behavior remains intact.

The installer verifies SHA-256 before unpacking, rejects unsafe paths/links/special files, stages an owned version, checks the launcher, atomically switches `current`, and configures PATH. Failed preparation preserves the active version. Retained old versions consume additional disk.

## Measured size and verification

macOS arm64, actual assembled artifact:

| Measurement | Production core | Optional browser development tools |
| --- | ---: | ---: |
| Compressed core archive | 90,087,787 bytes / 85.9 MiB | Separate download, not in core archive |
| Installed file contents | 260,139,952 bytes / 248.1 MiB | 225,846,579 bytes / 215.4 MiB |
| Allocated files on this filesystem | 277,823,488 bytes / 265.0 MiB | 226,373,632 bytes / 215.9 MiB |

Core has 3,698 files and 156 package identities. Allocation varies by filesystem. App data, previous versions and extraction staging are additional. The optional installer now directly extracts its pinned packages without a package-manager cache.

### Remaining largest files and reductions

The prior verified core was 124,481,988 compressed bytes, 392,285,799 file bytes and 423,755,776 allocated bytes. The new core saves **145,932,288 allocated bytes (139.2 MiB / 34.4%)** and **34,394,201 download bytes (27.6%)**, while adding the qualified local resource workflows below.

| Largest retained item | Before file bytes | Current file bytes | Why retained |
| --- | ---: | ---: | --- |
| Node | 122,503,472 | 97,507,728 | CLI, detached sessions, native modules, module hooks and bundler orchestration |
| workerd | 114,566,712 | 69,906,976 | Actual local Worker/D1 execution for preview and inline examples |
| Bun | 61,884,464 | 0 | All four production bundling calls now use Node + esbuild |
| libvips binary | 17,765,192 | 17,765,192 | Miniflare's required Sharp image transform dependency |
| Wrangler CLI | 17,328,110 | 17,328,110 | Cloudflare deployment CLI |
| esbuild native binary | 10,573,778 | 10,573,778 | One shared 0.28.1 version for Can and Wrangler |

Native symbol removal uses `strip -x` on owned macOS copies, retains external symbols needed by native addons, then applies/verifies ad-hoc signatures. No machine code is removed. Linux uses conservative `strip --strip-debug`; its later local qualification is recorded below. Removed 918,172 bytes of unexported CSV UMD/IIFE distributions, retaining all package export targets and consumed ESM/CJS modules. Bun's license remains in contributor tooling sources but is no longer part of the core payload.

MCP handlers, HTTP operations, browser resource transport and generated saved-view clients now build through a Node subprocess using esbuild's JS API. It retains process timeout/output limits, lifetime checkpoints, cleanup/error precedence, whitespace settings and required exports; refuses external imports and uses a stable virtual sourcefile for deterministic output. Pinning Can to Wrangler's existing 0.28.1 avoids adding a second native bundler version. Node-host behavior stays on Node; consolidating onto Bun would require different IPC/module-hook/native-addon qualification and offers no demonstrated compatibility advantage.

Further deletion candidates are bounded: Sharp's full closure is 19,103,277 bytes, but deleting it disables Miniflare Images transforms and violates its required dependency graph. workerd's 4,747,010-byte `worker.mjs` is Wrangler's runtime-type producer. Miniflare's 1,807,166-byte explorer assets support an upstream opt-in feature. None is silently removed. A substantially smaller engine payload needs a deliberate host/local-engine redesign, not another manifest classification change.

The shipped Miniflare 4.20260730.0/workerd 1.20260730.1 stack supplies the actual local engine without another install. The compiler and preview derive R2, KV, typed queues, Durable Objects and analytics from checked source. Real authenticated R2 upload/finalize/attachment/protected-read and root workflows pass. Guarded/unconditional File queues pass attachment at 23 hours, delivery at 25 hours, failed handler commit, restart and exactly-once effects with persisted R2 bytes. API-only apps need no dummy page. The finite supported cases and explicit held profiles are recorded in [the current local-binding execution view](local-bindings.md).

All 18 final-archive installed-core checks pass from an external application with only `/usr/bin:/bin` in the developer PATH. These include real inline examples, native Sharp PNG execution under stripped Node, and automatic R2/DO and model-free queue preview provisioning. Preview input capture now records both Node and the actual esbuild native producer; admission validates those paths and pins that same binary while building, with environment restoration afterward. Twenty-five focused capture/input checks pass, including empty PATH and explicit binary overrides. Real bundler checks pass for all four families, deterministic bytes, HTTP body/permission behavior, MCP authorization/member dispatch, stylesheet serving, and saved-view execution with an empty PATH. Thirty cleanup/preparation checks and seven cumulative lifetime/timeout checks passed; a direct process probe confirmed esbuild's native service exits after its Node parent is killed. The optional Node-only installer and real headless page pass; all three resolver checks pass using stripped Node and the separate tool root. Prior unchanged installer/owner checks are reused.

The integrated source build passes all 13 packages (26 tasks), with focused Cloudflare rebuilds after the final preview fixes. The archive records `inputMode: built-checkout`; it no longer relies on frozen older JavaScript outputs. The matching Rust release and notices pass with 122 captured compiler/Values inputs unchanged during the build. Installed qualification caught an older compiler's missing caller-fixture dependency; rebuilding the current source fixes all four original Office examples. Complete compiled artifacts for the File-queue and three root fixtures remain identical, so their unchanged qualification is reused. The actual installed root/File and root/queue controls also pass with the bundled tools and clean PATH. Browser add-on results are reused because its private Node, installer and pinned packages are unchanged.

Generated evidence: `output/install/{size-report,verification,browser-development-verification}.json`; archive manifest includes component bytes and package versions. Linux x64/Ubuntu 24.04 CI assembly is prepared, not executed. Linux browser add-on OS libraries remain a separate qualification requirement. Authenticated deployment, public GitHub assets/curl endpoint and Homebrew publication are not complete. Service/provider credentials and authored browser tests remain application inputs; Git is needed only for explicit git-revision rollback.

Upstream commit `c3931b71` records the subsequent Linux x64 qualification on
Rocky Linux 10.2/glibc 2.39, which passes all
21 installed checks, including a real Bash-stdin installation with a utility-only
PATH, native execution, inline examples, protected preview and automatic
R2/Durable Objects/queue State. It fixes concurrent owner-pin inspection and
the preview/native snapshot digest spelling while preserving strict refusal
controls. The prior macOS measurements above are retained; no new macOS or
Linux browser add-on run is claimed. See the [installation reference](../../install.md#linux-x64-qualification--2026-10-15)
for the exact Linux bytes, native versions and glibc 2.39 minimum. CI execution
and public publication remain pending.

The earlier `jev-{1,2,3}.json` advised preserving both runtimes for the initial bounded assembly. The user's follow-up explicitly authorized consolidation work. There was no directional disagreement. Advice does not establish compatibility: the actual four-family execution and installed archive checks do. Replacing Node host execution with Bun remains separately proposed, not required for this reduction.

## Public shell bootstrap handoff

The canonical `scripts/install.sh` supports `curl -fsSL
https://sodaos.dev/CanLang/install.sh | bash`, fetching platform archives and
checksums from GitHub Releases. The website is maintained externally; the
[copy-ready website agent prompt](website-handoff.md) records its exact route,
release link and deployment checks. All 12 installer checks pass, including
streamed Bash/sh input, truncated bootstrap refusal and latest GitHub selection. A real existing macOS archive installs through Bash with a clean PATH and runs
`can --version`. The tag release workflow publishes qualified standalone assets; no hosted download or website deployment is claimed here.

## Cleanup reconciliation

The 2026-10-15 source review and integrated package validation are recorded in
the reconciliation record. The measured archive and18 installed checks above describe the retained archive,
not a newly repackaged cleanup build. Current source passes the integrated26
build tasks, owning installer/host controls and resource native checks. Review
also fixed selected composed Files ownership, event mutation/root placement and
separate browser sidecar publication. The optional sidecar packer and publisher
are directly tested; no release has been uploaded. All work is the coordinating
agent's responsibility.

Merge reconciliation ran the enhanced upstream verifier against the retained
macOS archive: all 21 installed checks pass, including Bash stdin, the utility-only
PATH, native execution and actual installed-byte measurement. This validates the
merged verifier against existing archive bytes; it does not claim a newly built
archive contains the merged source. The installed file total is 260,140,017 bytes,
including the 65-byte installer marker. Prior reports remain in
`output/install-refresh/merge-verifier-before`; the updated report is
`output/install/verification.json`. Linux's 21 checks remain the upstream
`c3931b71` qualification, without a fresh Linux or browser add-on run here.
