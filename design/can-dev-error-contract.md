# Compact `can dev` error and revision contract

**Status:** selected pre-implementation design contract, not a shipped response. It extends the existing compiler [diagnostic envelope](../compiler/src/diagnostic.rs) rather than changing that envelope's schema or inventing a second checker. The development session, source-closure capture, help join and follow-up references described here do not yet exist.

## Identify the exact checked input

Each check captures one immutable record before analysis. It contains the selected app root, every `.can` input actually supplied to the compiler (including editor buffer overlays), their workspace-relative logical paths and SHA-256 of their **exact UTF-8 bytes**, plus the consumed compiler executable, language version, catalog bytes or explicit missing-catalog state, help-index revision, checked capability profile and semantic options. The source list records membership as well as contents; adding, removing, renaming or editing a source creates a new source revision. Current CLI checking accepts explicit file operands and does not discover this whole app closure automatically, so an incomplete capture cannot claim a complete project check.

The compact response carries three related identifiers:

- `session`: an opaque identity for one checkout/worktree development session.
- `revision`: a short, monotonic session epoch such as `r18`, bound to the entire immutable capture and analysis configuration. It advances when source membership/bytes, compiler build, catalog, help index or semantic options change. The selected app and capability profile are fixed for one session; changing either starts a new session under the [session contract](can-dev-session-control.md). It is the key for detailed lookups and currentness checks.
- `source_revision`: one full SHA-256 digest over a versioned, length-delimited encoding of the sorted `(workspace-relative path, exact-byte SHA-256)` source entries. The full digest is present in machine output; readable output may abbreviate it. It identifies source bytes and membership independently of the selected app, session counter, Git commit, file timestamp or `SourceDb` numeric ID.

The immutable revision record retains the source manifest and all non-source input identities. A source revision may stay the same while a catalog or compiler change advances the session revision and changes diagnostics. The dev server must capture from one checked snapshot and verify membership/bytes before publishing it as current; a watcher notification by itself is not a coherent snapshot. If files change during capture/check, publish the old result only as historical (`current:false`) or recapture. Never move an old span onto newer text by matching its line number.

The current compiler already emits per-file exact-byte hashes, canonical half-open UTF-8 byte spans, tool/language/schema versions, `complete` and `omitted`. Its `complete` covers analysis of supplied files, not source-closure discovery, help-candidate coverage, Jev availability or runtime execution. Compiler package version or a short Git HEAD does not identify a dirty binary; the session record needs the actual consumed compiler build identity. Preview/build responses have a separate artifact/build revision and state which source revision they serve. A check error has no successful build revision.

## One compact check response

The default reply has one **focus**: the first error in the compiler's canonical order, or first warning if there is no error. This is a selection for compact display, not a claim that the focus caused later diagnostics. Return counts and a revision-bound cursor for every other emitted diagnostic. Keep compiler `omitted` separate from diagnostics merely left out of the compact page. Never say “clean” unless source capture and compiler analysis are complete, no blocking diagnostic exists and compiler `omitted=0`.

Schematic JSON (field values illustrate a future qualified profile, not an actual current compiler result):

```json
{
  "schema": "can.dev.check.v1",
  "session": "s7",
  "revision": "r18",
  "source_revision": "sha256:$full_source_set_digest",
  "current": true,
  "state": "errors",
  "evidence": {
    "capture_complete": true,
    "analysis_complete": true,
    "diagnostics_reported": 4,
    "diagnostics_omitted": 0
  },
  "focus": {
    "ref": "s7/r18/d0",
    "code": "E1200",
    "severity": "error",
    "message": "expected scenario or crud declaration",
    "at": {"path": "app.can", "start": 83, "end": 89, "line": 7, "column": 2},
    "help": {
      "state": "likely",
      "basis": "jev",
      "card": {
        "id": "can.v1.when.crud",
        "signature": "crud path by=expr fields=selectors",
        "meaning": "Generate enabled create, update and delete operations.",
        "availability": "qualified_in_selected_profile",
        "link": "docs/specification/CONSTRUCT-HELP.md#can-v1-when-crud"
      },
      "alternative_ids": ["can.v1.when.scenario.user"],
      "detail_ref": "s7/r18/d0/help"
    }
  },
  "next_diagnostics": "s7/r18/diagnostics?after=d0"
}
```

`at.start` and `at.end` retain the released diagnostic wire's half-open UTF-8 byte offsets; `line` and `column` are derived 1-based display coordinates, never a second source of truth. The detailed diagnostic retains the compiler's exact `primary`, `related`, `tags`, source-file ID and file SHA-256. The server does not rewrite the compiler's `schema_version` or its diagnostic message to fit the help card. `state` distinguishes `errors`, `valid`, `incomplete`, `limited` and `tool_failure`; a tool failure is not an empty diagnostic list. `valid` requires complete capture and analysis, zero blocking errors and zero compiler-omitted diagnostics.

The inline card uses the Can-owned ID, signature, meaning, qualified availability and stable link. Jev supplies only the ranking, never the syntax or link. `basis` is `deterministic`, `structural` or `jev`; probabilities, evidence packet and other card examples stay behind `detail_ref` so the common reply remains small. If one occurrence is ambiguous, at most two alternative IDs and the smallest author choice can appear inline, without claiming a replacement. The exact candidate-eligibility and provisional Jev display gates remain in the [ranking contract](can-dev-jev-ranking.md).

## Status-specific help

| Condition | Compact response |
| --- | --- |
| Exact grammar match, such as `Text` in a known type slot | Keep the compiler diagnostic; `help.state=exact`, `basis=deterministic`, one canonical card, no Jev probabilities. |
| Layout/parse recovery or unknown slot | `help.state=structural`, a small canonical scaffold/static explanation, no ranked keyword. Preserve the other diagnostics behind the cursor. |
| Several supported meanings but unresolved author intent | `help.state=intent_unclear`, no top card, two distinct construct IDs and the decision needed; full candidate evidence by reference. |
| Candidate inventory/profile incomplete | `help.state=candidate_coverage_unknown`, no `none` conclusion and no Jev call. |
| Jev selected `none` over a proven complete eligible set | `help.state=none`, no replacement card; explain the unsupported behavior or missing construct boundary. |
| Jev pending, disallowed, timed out, rejected or malformed | Keep compiler error and deterministic help; `help.state=pending` or `ranking_unavailable` with a bounded reason code and revision-bound detail reference. No invented fallback rank. |
| Incomplete source capture or compiler analysis | `state=incomplete`, disclose the missing stage, never report a clean app or auto-rank that occurrence. |
| `diagnostics_omitted>0` after otherwise complete analysis | `state=limited`, disclose the count, never report a clean app or auto-rank from that limited envelope. |

A readable rendering of the JSON example is:

```text
app.can:7:2 E1200 [s7/r18; source sha256:$short] expected scenario or crud declaration
Likely: crud path by=expr fields=selectors — generate enabled create, update and delete operations.
Can help: can.v1.when.crud (qualified in selected profile); alternative: can.v1.when.scenario.user
4 diagnostics reported; 0 omitted. Details: s7/r18/d0
```

For `intent_unclear`, the second line instead names the two contracts and the author decision; for provider failure it says ranking is unavailable and preserves the deterministic alternatives. A result with incomplete capture/analysis says so before any suggestions. The readable renderer may abbreviate hashes, but the machine reply and revision detail retain full values.

## Follow a reference without stale evidence

`s7/r18/d0` identifies one occurrence in the immutable `s7/r18` result. A diagnostic-detail lookup returns the released compiler diagnostic fields, source file hash, related spans, any proven causal links, candidate-coverage facts and a small source excerpt from the captured bytes. A help lookup by `(revision, construct ID)` returns that revision's authoritative signature, meaning, example, availability, documentation link and help-index identity. A Jev detail adds returned model, complete choice probabilities/confidence, usage, timing, `none`/`unclear` and any failure class. These are **candidate operations**, not accepted API names; they never reread current disk contents for an old ref or dump the full manual in the default response.

The caller supplies the expected `session/revision` on follow-up. If it is historical but retained, return the historical record with `current:false` and the current revision ID. If evicted, return `revision_unavailable`; do not substitute the current card or source excerpt. A source edit, membership change or changed analysis input invalidates pending ranks for the old revision. Any optional edit action separately verifies the current file's expected SHA-256 and byte ranges through the existing [guarded fix contract](../compiler/src/ide/fixes.rs); no Jev result changes source or grants authority.
