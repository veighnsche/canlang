# Installed Can declaration acceptance

Final `node scripts/verify-installed-types.mjs --skip-build` passed its **owned declaration
and consumer gate** on Node 24.21.0, Bun 1.4.2 and TypeScript 5.9.3. The default command prepares producers through the public `bun run build`;
`--skip-build` consumes existing complete package outputs, as in this review.
No live producer builds were executed by this review.

All 13 producers were actually packed with Bun and installed from local
tarballs outside the checkout with `bunfig.toml` explicitly selecting the
isolated linker. Canonical `.bun/.../node_modules/@canlang/...` owner paths
are recorded, and the same realpath owner classifier governs imports and
diagnostics, including negative gate rejection. Bun rewrote workspace dependency ranges to
package versions; tarball overrides selected all local owners. Installed
producer directories, resolved declarations, compiler libraries and every
program source stay inside the consumer. The compiler child is denied checkout
reads by Node permissions. Explicit consumer tooling supplies @types/node
24.19.1 and @cloudflare/workers-types 5.20261004.1; these are declared tooling,
not aliases or local producer source fallbacks.

The fixture imports every one of the 150 explicit typed exports, including
runtime, testing, bindings and distribution entries. Untyped asset entries are
recorded separately rather than blindly imported. Every typed module has
exported symbols; concrete bigint and D1 storage API assignments also typecheck.
Strict NodeNext noEmit compilation uses `skipLibCheck: false`. There are zero
consumer/Can declaration diagnostics and zero undeclared owned imports.

Negative controls delete and then semantically corrupt the installed contracts
root declaration. Missing declarations produce new consumer resolution errors;
corruption produces an owned TS2304 unknown type error. Both are explicitly asserted to fail the actual owned/consumer gate, and restoring
the original bytes recovers exactly the baseline. The negatives modify only the
scratch consumer.

**Third-party typing limitation:** the full program reports 797 diagnostics,
all in the isolated installed `miniflare/dist/src/index.d.ts`, for
miniflare 4.20260730.0. Exact canonical locations are recorded in the evidence.
These include absent internal declaration imports and incompatible imported
SDK symbols. They are preserved in full and are excluded only from the explicitly
scoped Can/consumer gate. This is not a claim that whole-program strict library
checking passes. No vendor patch, dependency change or skipLibCheck workaround
was introduced.

`isolated-final-probe.log` records the complete final isolated
pack/install/verification run. Earlier non-isolated `final-probe.log` remains
historical evidence.
`evidence.json` records sources, symbols, tool versions, diagnostics and controls;
`resolutions.json` records module resolutions; `tarballs.json` pins actual packed
bytes and rewritten versions. Raw diagnostics, fixture, consumer manifest and
lock are alongside them. Scratch is retained at the path in the log. Earlier
logs preserve the original sandbox tempdir failure and initial whole-program
failure; the final scoped result is the acceptance result.
