# Package responsibilities and real callers

Step 2 of the simplification audit, 2026-10-07. This is a read-only source and
caller inventory. Implementation remains deferred; native preparation HOLD,
backend adoption and TS retirement gates remain unchanged.

Start with the [coverage map](coverage-map.md). It assigns one current package
owner and a caller status to each maintained responsibility. Mixed files have
separate duties rather than one misleading whole-file adoption label. Detailed
[records](responsibilities.jsonl) retain source locations, caller kinds, entry
chains, public exposure and unresolved limits.

## Source and scope

The source pin is `851352d5225f0d707246eba7da81482087566994`. Its package tree is
identical to the [step 1 baseline](../production-baseline/README.md) current
snapshot `8f33aa5e29d25bf3ea4d6035c7b2e3ddc0427854`. Concurrent compiler work is
preserved; this audit does not claim adoption of later compiler changes.

**316 responsibilities across all 13 packages** are mapped, with **395 files**
including 30 packaging/public-support records outside the production denominator.
[File coverage](file-coverage.tsv) includes every
baseline implementation, generated asset, runtime-data, build-tooling and asset
file: **365 production/delivery files**. Packaging declarations, public fixtures
and test-support exports needed to describe the boundary are included separately.
[Verification](verification.json) records exact final counts and hashes.

Every one of **156 npm export keys** is explicitly mapped in
[public APIs](public-apis.tsv), with conditions, declared output targets, owning
source/assets and responsibility IDs. Reexport module candidates describe a
structural surface; they do not assert every symbol in each module is reexported
or called. Step 1's reproducible `interfaces.tsv` retains individual exported
function/type/declaration candidates. The responsibility map groups those by
maintained duty; it is not a proof of every function or branch executing.

## How to read the caller status

| Status | Meaning |
| --- | --- |
| `production-observed-source` | A reviewed command, mounted handler, generated/owning source assembly or downstream source consumer exists. Its precise kind and chain are recorded; this is not execution proof. |
| `conditional-production` | An implemented callback, optional backend, supplied port or explicit consumer selection exists, with a missing/default-host/adoption condition retained. |
| `test-only-observed-call` | Concrete calls or constructors are observed in tests/support. No current product caller was established for that duty. |
| `public-api-no-observed-in-repo-call` | The declared public surface has no observed local direct caller. External consumers may exist. |
| `prototype-unadopted` | Registered/extracted/explicit support code lacks the selected product transport/backend/consumer adoption. It may be executable and tested. |
| `type-contract` | Maintained declarations or erased contracts describe an interface; executable barrels are classified separately. |
| `generated-staged` | Generated code/assets or emitted data are present or staged. Presence is separate from loading, initialization and use. |

A package import, export barrel, emitted wrapper, live test or source hash is not
by itself proof of a real product call. A function reference forwarded as a
callback is kept distinct from a call. Testkit and exported testing helpers are
legitimate test-support responsibilities, not product adoption failures.

**No code is declared dead and no deletion is authorized.** An unreachable-path
claim needs affirmative entry/dispatch/condition evidence. No observed caller is
weaker evidence. Public retirement requires explicit interface, external-consumer,
compatibility, target-host and deprecation consideration before implementation.
The TS backend and semantic/authority owners remain protected by their own gates.

## Concrete entry-chain findings

- **Commands:** `can-platform` dispatches run/test/build/deploy/activate/docs.
  Normal build/deploy calls the TypeScript prepared host. Explicit native
  selector/job APIs and the registered `can-preparation` binary remain a separate
  unadopted path. CLI `run` assembles modules and reports an entry URL; `test`
  boots a local scope but reports zero rows until its artifact loader is joined.
- **Mounted HTTP/MCP:** the portable Worker main lazily assembles real D1/identity
  producers, an artifact registry, MCP handlers and HTTP operation handlers.
  Canonical mutation/read uses real owning state producers. Ordinary reads use
  `createReadInvoker` and its bound reader; nested scenario reads separately call
  `invokeRead` directly. Full HTTP composition is not mounted by this worker:
  `/auth` returns an interim 501, file routes are interim, and file-kernel/ingress
  bindings throw when their unjoined paths are used.
- **Browser and pages:** compiler-generated page wrappers call `renderPage`; the
  current worker invokes a descriptor callback. Ordinary generated full-page
  wrappers omit the required shell argument, so source inspection identifies a
  shell-missing failure condition. Browser bootstrap/polling/CSS can be copied
  and explicitly staged, but current page markup has no automatic asset/start
  join. `startBrowserClient` needs an actual call; staging bytes is insufficient.
- **Receipt/work:** selected receipt fallback resolves the real public
  `@canlang/work/receipt` functions in the repository Node profile. The portable
  bundle rewrites/stages state receipt producers but not that work specifier.
  This leaves an installed receipt-consumer gap. Observation does not establish
  cancellation, resume or related-progress mutation adoption.
- **Dispatch/fanout:** Cloudflare dynamically loads state producers. Work command
  arrays, planners/providers and authority ports are supplied at composition
  seams; they are not automatically loaded work modules. Real recipient tests
  exist, but no default worker driver/scheduler mounting was established.
- **Rust values/work:** values owns the common arithmetic/validation core and
  bindings. Existing Wasm smoke evidence is explicit opt-in and finite; public
  structural validators still use TS. Work-kernel registers Rust decision
  candidates, while its TS extractions have no observed product import. Rust
  files/registration are separate from transport, host and installed adoption.
- **Services/files and public helpers:** mail/model/judgment/media adapters,
  file lifecycles and some HTTP/CSV/export/print APIs have concrete test/injected
  consumers. Their public obligations remain. They are not classified as removed
  or dead just because the current worker lacks the full host workflow.

These are source findings for later simplification/adoption decisions, not a new
implementation queue or a whole-programme completion claim. Original T08/T26,
authenticated app journeys, durable authority/lifetime and full backend gates
remain outside the narrow credited receipts.

## Evidence and independent checks

The read-only TypeScript 5.9.3 index reads pinned Git blobs for packages, root
commands, scripts, tests, tools, CI JavaScript and examples. It records **707 code
files, 4,295 import/reexport edges and 55,596 symbol-bound import-use candidates**.
Those are discovery candidates, not executed statements or adoption counts.
Manual traces cover dynamic producer loads and compiler-generated strings.

[Dynamic imports](dynamic-imports.tsv) preserves all 60 statically unresolved
expressions. They include support/conformance loaders and input-dependent module
URLs. No unresolved expression is silently counted as dead. The index omits
Rust call binding, YAML workflow execution and generated string reparsing;
namespace aliases, callback forwarding, reexports and dynamic destructuring need
manual review. It is conservative, not a compiler/runtime reachability engine.
The current npm targets map, but generalized wildcard/config-extends and
`.mts`/`.cts` output mapping limitations remain documented.

[Independent Sol medium reviews](independent-review.json) challenged the handler,
browser, state/work, Rust adoption and installed claims, and exercised synthetic
index controls for lexical shadowing, types, aliases, constant dynamics and asset
mapping. Precision corrections added real test constructors, executable barrels,
the canonical read-factory chain, injected work/state distinctions and actual
release-manifest command callers.

[Prior receipts](prior-receipts.json) rehash **15 checked-in raw logs**, compare
**37 selected source rows** and **55 Cloudflare bridge rows** with this pin, and
retain their exact selected Node/workerd/installed diagnostic profile. They do
not establish new authenticated receipt/page/browser/provider workflows. No new
product build, test, install, backend selection or deployment ran in this audit.

## Reproduce and validate

From the repository root with the existing Python and TypeScript 5.9.3 dependency:

```sh
python3 docs/research/package-library-audit-20261006/production-baseline/measure.py \
  --out /private/tmp/canlang-package-baseline
python3 docs/research/package-library-audit-20261006/responsibility-callers/index-inputs.py \
  --out /private/tmp/canlang-caller-index.json
python3 docs/research/package-library-audit-20261006/responsibility-callers/verify.py \
  --index /private/tmp/canlang-caller-index.json \
  --baseline-files /private/tmp/canlang-package-baseline/files.tsv
```

The map is maintained reviewed data. These commands reproduce discovery/baseline
inputs and verify source pins, all file/API/owner associations, evidence locations
and retained log digests; they do not automatically rediscover the human-reviewed
semantic duties. Regenerating the caller index twice produced identical bytes.
Detailed source/use dumps remain temporary instead of being copied into another
committed source tree. Economical technical delegation used **Sol medium**, as
requested, for finite source groups and independent challenges.
