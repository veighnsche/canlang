# Library fit against required behavior

Step 4 of the package simplification audit, 2026-10-07. **Planning only.**

The [assessment](assessments.md) compares **27 integration slices covering all 25 historical library findings** against the [classified contracts](../required-behavior/contracts.md). Those slices are audit units, not 27 new implementation tasks or an inventory of every transitive dependency. Each comparison includes current source, library plus minimum owner wrapper, platform primitive and retention, with the same required outcomes, selected API/options, initialization, hosts, license and dependency burden.

Source is frozen at `f8e9e73b11f19a7d59ac62487033a5bc189c46a1`. The package tree is unchanged at verification. Current compiler documentation work is separate and preserved. The [source index](source-index.json) records repository and read-only dependency hashes. No dependency installation, product build/test, policy change, backend adoption or implementation was performed.

## Findings that change the simplification plan

- **Many intended replacements are already in source.** Number text, Rust-str escaping, import discovery/edits, map composition, CSV grammar, identity codecs/cookies, native equality and signal fan-in use their chosen libraries or primitives. Old “unwired” premises must not generate repeat implementation. Their exact host/installed/workflow gates remain distinct.
- **Remove repeated mechanics around a fitting library.** `ryu-js` already handles String nonfinite/zero cases; the JSON channel still needs its own null policy. Strict UTF16 admission plus one percent-encoding ASCII set can replace the URI mechanics. The platform exact-string Intl route may remove manual locale formatting, after host/data and consumer-output qualification.
- **Source maps have a real adapter-burden hotspot.** Per-segment decode, manual accumulation/lookup, endpoint/prefix-max transforms and large-delta carriers deserve a finite profile decision. Whole-map library APIs are promising, but duplicate-column selection differs even for ordinary sorted maps. Raw source identity, fallback diagnostics and current public inputs cannot silently change. The [review](review.md) records the required distinction.
- **A library cannot settle a policy or persisted-byte dispute.** Canonical JSON does not decide normalized versus raw replay hashes, private CSV review authority, or permissible host-object admission. Resolve each owning profile rather than building a universal emulation layer or silently rehashing current objects.
- **Some proposed replacements would add maintenance.** Keep the strict Ollama protocol for the inspected SDK version; malformed-line skipping/warnings conflict with fail-closed privacy. Keep exact arithmetic, one semantic validator/authority core, tagged transport, the current bounded ICU parser, small CLI grammar and small owner policies where the candidate would recreate their mechanism.
- **Correct the evidence before choosing options.** The current export emits LF, not CRLF; the inherited audit rule is corrected. CSV import admission of LF/CRLF does not define export bytes. Candidate version/source inspection is also separate from the current installed tree: several selected exact JS versions are missing from the inspected local roots. No installation was performed to conceal that gap.

## Practical comparison

| Integration family | Assessment | Change gate |
| --- | --- | --- |
| Number text / valid-str JSON quoting | Already delegated; smaller ryu String wrapper possible | Finite caller/error/zero/nonfinite corpus; UTF16/truncation is separate |
| Imports / maps / loadability | Imports fit; maps need profile reduction; AST loadability is conditional | Producer grammar, scope/provenance, duplicate/raw map contracts and installed diagnostics |
| CSV / identity / HTTP | Retain adopted mechanism seams | Business/authority/atomicity and actual host qualification remain owner duties |
| Calendar / locale / URI | Narrow candidates or platform route may remove real algorithms | Exact host/data/domain and persisted identity compatibility |
| Decimal / validation / state / work / carriers | Keep semantic owners over existing primitives | Do not add duplicate precision/default/transaction/authority engines |
| Canonical JSON | Retain now; profile-specific library fit unresolved | Separate actual data admission, preimage history and migration evidence |
| CSV export / TOML / file type | Conditional, demonstrate benefit over small current mechanics | LF quoting/armor, native HOLD/UTF16, supported sync format domain |
| Ollama SDK | Reject this inspected candidate for required strict parsing | Reassess only a materially different strict, bounded API |
| SDK / build / crypto / IO / small policies | Existing seams fit; no new universal adapter | Actual shipping closure, bytes/publication, authority and sink policy |

## Evidence and limits

Three focused **Sol medium** assessments use versioned primary source and pinned repository contracts. A finite **Sol high** challenge reviews consequential serializer/CSV/source-map/numeric compatibility claims; prior independent persisted-security findings are reused rather than replayed. No new persisted policy or difficult design choice was selected, so JEV adjudication is left for the finite decision that actually changes an owning contract.

Ten exact npm publication artifacts were retrieved into private audit storage, checked for package name/version and SHA512 integrity, and read without installation or scripts. Eight are selected lock inputs; CSV stringify and Ollama are evaluation-only. [Dependency evidence](dependency-evidence.json) preserves compact hashes/metadata rather than committing third-party sources. Cached Rust manifests/source and exact installed MCP/decimal.js/esbuild metadata were also read. Their source/API fit does not establish actual native/Wasm/Node/workerd/browser support, a shipped closure, security acceptance or footprint savings.

Maintenance comparisons cover algorithms removed/retained, wrapper obligations, dependency/features/host initialization and upgrade witnesses. No claim is made about current maintainer response, security advisories, transitive vulnerability status, measured bundle size or release cadence. License metadata/available notices are recorded; this is not a full license-compliance review. Retention is temporary where the owning contract remains unresolved, not a decision to preserve every historical quirk.

[Machine records](assessments.jsonl), [finding crosswalk](finding-crosswalk.tsv), [upstream references](upstream-evidence.json), [review](review.md) and [decision record](decision-record.md) preserve exact scope and residuals. Continue planning with the named profile questions and minimum-wrapper opportunities; implementation remains deferred.

Reproduce the audit structure and repository hashes from the root:

```sh
python3 docs/research/package-library-audit-20261006/library-fit/verify.py --repo .
```

Add `--external` to recheck available private/cache evidence files. Missing private files on another machine are reported as unavailable, not new consumer acceptance.
