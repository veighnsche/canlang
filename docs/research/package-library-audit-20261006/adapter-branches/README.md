# Adapter branch audit

Step 5 of the package simplification audit, 2026-10-07. **Planning only; implementation remains deferred.** Source checkpoint: `7870143465cf3d73e68339a6aa8d82109bd58397`.

This audit covers the selected adapter closure across all 27 [library-fit integration slices](../library-fit/README.md), including the held native import counterparts. It explains each inventoried branch/group, its authority, why it exists, proposed disposition and the exact prerequisite for changing it. The [scope](scope.json) names complete functions and explicit slices; excluded arithmetic, language parsing, validation, authority and workflow algorithms remain owning Can responsibilities. This is not a claim to have proved every package path correct or every library upgrade safe.

[Branch records](branches.jsonl) are the detailed output: **480 groups across 408 named functions/slices**. **322 retain, 47 simplify, 62 consolidate, 49 eliminate**; the 158 reduction candidates remain conditional. Overlapping seam analyses may describe the same source boundary; counts are not unique physical branches or projected LOC savings. `retain` means preserve now, not an irrevocable decision. `simplify`, `consolidate` and `eliminate` are conditional proposals, not implementation permission. Counts are in [summary.json](summary.json); a group can explain several nested controls and is not an independent implementation task. The [crosswalk](integration-crosswalk.tsv) maps all 27 integration slices without adding obligations to the combined programme.

## The three priority seams

| Seam | Why the extra code exists | Retain now | Conditional reduction |
| --- | --- | --- | --- |
| Unicode import recovery | The selected lexer needs an equal-width whitespace view and bounded restoration at failing line-separator positions; original literal reparsing restores decoded identity and original offsets | Can import policy, raw/decoded identity, original UTF16 spans, matching-delimiter escape, trusted-producer distinction and map ownership | Retire the projection/retry/reparse only after an actual selected lexer/API supports the authored domain with the same offsets and refusal policy. Do not substitute a second handwritten JS decoder |
| Source-map compatibility | Per-segment decode and manual accumulation/lookup preserve raw admission, unusual order/deltas and last equal-column selection; composition adds prefix-max projection, opaque table identities and large-delta carriers | Reliable original `.can` diagnostics, source identities and selected duplicate-column behavior | Choose a finite real producer/public/stored-map profile. Whole-map codec/trace APIs can then replace broad emulation; ordinary sorted duplicate columns still need a small last-wins bridge unless that contract changes |
| Cookie serialization order | The library generates correct attributes in a different order; the wrapper splits and rearranges its generated header to match a finite selected byte profile | Secure/HttpOnly/Lax/Path/expiry, clear consistency, validated Domain, encoding and first-target/once-only decode behavior | Eliminate attribute rearrangement after explicit byte-order consumer/profile review. No inspected in-repo caller parses attribute order, but external consumers remain unknown. Secure-option caching also needs a stable-value/accessor contract |

These are different causes. Lexer limitations are library compensation; raw map breadth is a compatibility profile whose required subset is unresolved; cookie attribute order is a selected byte profile, not itself a security property. Tests demonstrate a historical oracle but do not make every quirk a permanent product requirement.

## Other branches worth reducing

- **Use the existing primitive completely.** `ryu-js` can own numeric String spelling when its appropriate API is used; JSON still needs its nonfinite-null policy. Rust-str serde quoting does not replace lossless UTF16 quoting.
- **Remove duplicated mechanics at the owner join.** Host MCP/HTTP build phases, lossless render traversal and identical HTML entity traversal have bounded consolidation opportunities. Preserve phase/error order, separate sink names and held preparation status.
- **Replace a narrow algorithm only under its actual domain.** Strict URI encoding and exact-string Intl formatting may remove substantial custom mechanics; lone-surrogate refusal, persisted identity bytes and actual host/data behavior remain gates.
- **Do not build a universal serializer to merge superficially similar loops.** Replay, CSV consent, media identities and export presentation have different admitted values, own-key/getter/toJSON behavior, ordering and migration obligations. Consolidate only the equal declared subset, under one owner.
- **Keep policy outside parser libraries.** CSV malformed-input admission, safe error mapping, row/header limits, formula protection and authoritative review/commit remain Can responsibilities. Import grammar acceptance does not establish full JS validity; a loadability scanner needs binding/provenance evidence.
- **Keep wrappers that express real output or authority.** Projection sorting makes parent grants subsume children; report comparison sorting gives deterministic mismatch paths; byte snapshot copies prevent caller mutation; digest key sorting and kind/length framing define exact identities. Removing these merely to reduce line count changes requirements.
- **Retain a small owner algorithm where the candidate recreates it.** The current ICU grammar, exact arithmetic, CLI grammar and strict Ollama stream policy should not acquire another library plus equivalent compatibility engine without a concrete net benefit.

Every detailed candidate names the controls and change gate. A library integration is not simpler merely because the library is already installed, nor is retention justified merely because the current test suite asserts it.

## Concrete gaps kept separate from simplification

These are source findings and qualification limits, not newly executed failures or selected repairs:

1. The TS loadability comment blanker terminates line comments only at LF. Code after CR/U+2028/U+2029 can remain hidden from its CJS scan. Helper-name masking and scope-free name scans also lack a general binding/provenance guarantee. The import lexer's Unicode recovery does not fix this different scanner.
2. Source-map composition catches original-map decode errors only. Later remapping, table restoration and raw encoding failures are outside that catch. Nonstandard Array-property/raw-table and large-delta carrier profiles are not automatically stock-host parity.
3. Native preparation retains old import/path/scanner mechanics and remains **HUMAN HOLD**. Its path normalization unconditionally pops earlier `..` components: the static `../../x.js` trace collapses to `x.js` before the safe-relative check, unlike current TS normalization. Read-only audit does not certify equivalence to the TS lexer/edit route or authorize adoption.
4. Earlier publication finding F06 remains: reviewed-buffer metadata comparison is not disk-byte/exact-set verification or a mandatory verified-state gate. Re-reading a staged file is not a digest check. Synchronous cleanup is not universal asynchronous lifetime handling.
5. Tagged transport preserves essential f64/UTF16/order distinctions, but several caps occur after allocation. Shape guards and host coercion helpers do not by themselves prove all peer/input domains or general JS parity.
6. MCP uses a supported SDK extension; its inspected success guard accepts non-null non-array objects without a plain-prototype check, and the handler has no explicit local close/finally. These require their own admitted-domain/lifecycle evidence, not a claim of a demonstrated leak.
7. JSON no-throw probes are not lossless JSON admission. Prior persisted/security questions remain open until their own owner contracts and real consumers resolve them.

## Evidence and authority

Focused complicated-seam packets and finite independent challenges use **Sol high**, as requested. [Family notes](family-notes.json), [review](review.md), [source index](source-index.json) and [decision record](decision-record.md) preserve source pins, opposing evidence, proposal prerequisites and exclusions. No new semantic/security design is adopted; a consequential future choice follows the repository's JEV rule with a concrete balanced question.

The exact TypeScript syntax aid records selected control/mechanism occurrences with UTF16 offsets in [syntax-sites.jsonl](syntax-sites.jsonl). Nested short-circuits have occurrence suffixes; counts are structural coverage aids, not independent policy counts, runtime branch coverage or proof of semantic completeness. Rust branches are inspected manually and explained as match/guard groups. Dependency source is read from the earlier exact publication/cache evidence; no dependency installation or product execution occurs.

Historical finite acceptance remains credited at its real scope. Current missing local dependencies or absent private raw logs do not erase committed source-matched receipts. In particular, the identity packet records committed Node22/Node24/workerd acceptance and matching six source hashes; the private Node22 delivery log is currently unavailable. This corrects an earlier overly broad source-only Node22-gap description without inventing a new run. Saved import/map fixture acceptance does not certify the broader raw/source/loadability/native cases identified here.

No product source, dependency/lockfile, canonical task acceptance, active plan ownership, compiler work or living filetree checkpoint is changed. There are no new runtime tests, builds, probes, backend switches or TS deletions in this step.

Recheck the audit records and pinned hashes from the repository root:

```sh
python3 docs/research/package-library-audit-20261006/adapter-branches/verify.py --repo .
```

Add `--external` for available private/cache input hashes. Unavailable private files are reported as unavailable; they do not confer or invalidate consumer acceptance.
