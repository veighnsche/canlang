# Generated code persistence

Status: implemented for the finite persistence scope, 14 October 2026. `.can` remains clean. Verification and retained limits are recorded once in the current [execution view](implementation-plan.md#current-execution--clean-source-persistence-2026-10-14).

Keep `.can` clean and accepted implementation as ordinary editable files committed with the app. Keep durable IDs and source bindings entirely in the existing per-unit `unit.json` sidecars. Allocate new IDs randomly, preserve bindings through uniquely established semantic ownership or unchanged local structure, and let authoring tools update bindings deliberately during moves/copies. Every build consumes a consistent snapshot, including source-path resolution captured before analysis. Git remains the history store; Can needs no additional object database, global lockfile, or persistent module identity.

Reliability means preserving code and never silently assigning it to the wrong owner. It does not mean inferring every operation from final text. Ambiguous plain-text edits need an explicit move, fork or rebind; those actions require no AI generation and can be performed by the authoring agent without a human approval ceremony when the intended edit is already known.

## Implemented interface

`can gen status ROOT FILE.can... --format=json` returns source spans and current associations. Existing `can gen bind ROOT FILE.can START END REVISION ID` deliberately rebinds that ID, preserving implementation and provenance. JSON `bind` also accepts `"unit":"new","copy_from":"<existing-id>"` to fork the complete current group, including manually edited text and binary assets. Both paths reject stale selectors, incompatible target/signature changes and occupied destinations before publication. No command writes `.can`.

For nested source moves, compile with `--generation-root=ROOT`; the default is the selected source directory, with nested operand roots sharing their enclosing selected root. Transfer source and its saved group together for moves between independent roots, then bind in the destination. Builds never search unrelated ancestors or borrow another root's output.

Each record's optional `selector` stores the full semantic containment/role. Optional `region` stores `{container, sha256, count, occurrence}` for repeated structural intervals. The ABI remains readable for existing records without these fields. Explicit rebind refreshes evidence; reads never rewrite it. A changed ambiguous interval can require rebinding each affected unit. Copy does not guess correspondence for other edited slots.

Generation/refinement submissions retain patch semantics. Journal v2 supports explicit deletion and complete-group replacement, and continues recovering v1 journals. Exact Git rollback uses replacement; no incomplete candidate is reinterpreted as a complete group.

## Outcomes and alternatives

The governing outcomes are [saved zero-AI builds, stable ownership, editable implementation, complete retry acceptance and truthful provenance](../../../specification/BUILD_GENERATION_REQUIREMENTS.md). The previous folder name, sequential IDs and structural matching are mechanisms under reconsideration. `.can` and checked language/runtime owners continue to define composition, contracts, authority, evaluation order and schema migration.

| Alternative | What it does well | Cost for the same outcomes |
| --- | --- | --- |
| Embed generated JS/CSS in `.can` | Direct ownership and a single text change | Large mixed-language source, escaping/tooling complexity and noisy shared diffs; mandatory embedding conflicts with the current authoring outcome |
| Semantic companion paths | Easy to browse by declaration name | Anonymous units still need identity; moves/renames require a path pointer, lookup or reconciliation |
| Current structural records with random IDs | Shortest source; reuses existing tools | Random IDs fix allocation collisions but leave whole-file-revision fragility for duplicate anonymous nodes |
| Per-source association table with a structural baseline | One external map can share context and match unchanged subregions more automatically | A new sole-authority carrier, baseline reconciliation and same-source merge coordination; arbitrary edits still become ambiguous |
| Required exact locators with no local baseline | Small matcher and clean source | More explicit rebinding after ordinary changes around anonymous nodes |
| Content-addressed objects and a selection index | Immutable snapshots and deduplication | Editable materialization, index updates, merge rules and collection become additional mechanisms; hashes identify bytes, not ownership |
| One generated bundle per module | Few files and one output set | Unrelated units share diffs; selective editing and assets still need unit boundaries |
| **External unit records with checked local evidence** | Clean source, existing carrier, local Git conflicts and preservation through unrelated edits | Shared evidence may repeat across records; changed ambiguous regions need explicit reconciliation |

Source-carried IDs, including IDs hidden in comments, are excluded by the user's requirement. A per-source baseline is a valid alternative if actual authoring demonstrates excessive rebinding; it is not required for dependable explicit move/copy operations or unchanged-region preservation.

Git already stores content-addressed object history ([Git documentation](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)). That does not make Can's local publication atomic, but it removes the need to build another history/object store merely to preserve generations.

## External identity and clean source

Authors keep the existing syntax, with no persistence additions:

```can
style Surface $"A calm paper surface"

view ItemTile(row:Item) $"Arrange the item and canonical controls" $"Compact spacing"
```

Each defining slot receives an opaque identity recorded only in its saved group. New IDs contain 128 random bits in a portable fixed spelling, independent of prompt contents, paths, offsets, names, machines and recipes. The ID identifies implementation ownership; a locator is revisable evidence connecting that identity to current source. Validate observed duplicates even though random allocation avoids a shared counter.

Named traits, inline traits, keywords, styles and renderers use the same external ownership rule. A view's renderer and inline root style are separate roles with separate IDs. Named style/trait/keyword applications resolve to their definition and get no independent output group. Within a resolved output-owner scope, each defining slot has exactly one unit and each unit has one defining slot. A unit cannot be claimed twice or selected by whichever directory happens to be scanned first.

Evolve the current record rather than adding another binding file. Persist the relative source locator, checked semantic containment path, slot kind/role and the minimal local evidence needed to resolve anonymous slots. Semantic containment includes existing app/package ownership, named declarations, page routes, model/field ownership and their relevant nesting; the nearest component label alone is insufficient. These selectors are generated metadata, never additional names the author must invent.

For duplicate anonymous slots, replace whole-file SHA/span binding with an **unchanged local region certificate**: a uniquely identified semantic container and bounded structural interval, its normalized syntax fingerprint and occurrence count, and the selected occurrence inside that interval. Boundaries must themselves resolve uniquely. Normalization removes formatting/comments while retaining token values, kinds, relevant nesting and evaluation order; it must not collapse different string contents or treat reordered nodes as equal.

Resolve bindings under these finite rules:

1. A unique checked semantic selector establishes a named definition or independently distinguished slot. Prompt-only edits retain that owner and report freshness separately.
2. An anonymous occurrence may reuse its saved ID when its complete recorded interval resolves uniquely and matches exactly. Occurrence is an address inside proven unchanged structure, not a naked ordinal that slides across insertions.
3. Formatting/comments and edits outside the relevant interval do not invalidate that evidence. A changed sibling count, changed interval interior, missing/ambiguous boundaries or competing record invalidates the affected certificate. Independently resolved regions stay usable; compilation may still fail because the unresolved unit is required.
4. A supported move/copy/refactor supplies deliberate old-to-new correspondence and updates the affected records under the existing leases/journal. A plain text edit may retain a binding only with positive unique evidence. Do not use prompt similarity, nearest offsets, a sole unmatched pair or the cheapest global matching assignment as ownership proof.
5. Missing or competing correspondence produces a precise reconciliation diagnostic with current source locations and preserved output candidates. Ordinary build is read-only: it never rewrites metadata, chooses a disputed owner, regenerates code or drops output.

Check uniqueness against the complete relevant defining scope and its saved claims, not merely the subset of files a caller happens to inspect. A possibly displaced binding is an unresolved association, not evidence that its apparent replacement is a fresh prompt. Preparation must resolve that distinction before allocating or generating replacement output. Missing source paths alone do not prove a move or authorize stealing a disconnected unit. An unconsumed saved group of the same kind anywhere in that output root makes a new-looking slot ambiguous, including app/package renames. Legacy adoption also requires a unique current defining claim across the whole root. Unreadable or nonregular saved membership is an intake error, never an empty saved set.

The implemented certificate addresses the reproduced whole-file-revision failure without promising a general tree-matching engine. A prompt or structural edit *inside an otherwise indistinguishable interval* can require rebinding; a stored hash cannot explain which old occurrence changed. Smaller reliably anchored intervals reduce that friction. A per-source structural baseline could automate more such cases, but adds another representation and is separately proposed only if observed editing friction justifies it.

Two identical blocks can also be swapped while leaving identical text. No external metadata algorithm can recover an intention that leaves no observable source difference. A deliberate editor/CLI move can carry that intention. When only text is available, the unchanged representation retains its existing binding; the system must not claim to have detected that invisible move.

Preparation allocates bindings in external metadata before capturing generation inputs; it never inserts IDs into source. A failed first generation can leave a pending binding with missing output, reported explicitly rather than represented as accepted empty code. Ordinary build/check never allocates IDs. Source revisions remain exact candidate-acceptance fences, but are not permanent identity.

## Moves copies and merges

| Operation | Required behavior |
| --- | --- |
| Clone or relocate the whole project | Relative bindings and committed output remain usable without Git history, editor state or generation credentials |
| Can-aware rename or move | Update locators while retaining unit IDs and current output bytes; validate changed destination contracts |
| Can-aware copy or fork of a definition | Allocate fresh IDs and copy current implementation, including manual edits, without AI; validate the new owner |
| Plain source-file move | Use unique evidence to retain or propose a binding; otherwise request explicit reconciliation, preserving all files |
| Plain copy of anonymous source | Do not silently reuse mutable output; retain the original only where its correspondence is established, and fork/rebind the copy explicitly when needed |
| Deleted source | Report orphaned output; never reassign or delete it automatically |
| Conflicting or ambiguous Git merge | Preserve both sides and diagnose the affected bindings/code; a deliberate reconciliation resolves ownership without AI |

Implement these as authoring/refactor and existing bind/copy capabilities, not a mandatory editor extension or new CLI spelling frozen by this proposal. A move between app/package roots also transfers or explicitly rebinds the saved group. A file move alone is never permission to consume another root's output. A known requested edit supplies authorization to update its sidecar; only genuinely missing intent requires asking the user.

Git merges source, per-unit records and code as ordinary files. Separate additions use independent random directories. Changes to the same binding can conflict in that unit's record rather than a global lockfile. After any merge, check one-to-one bindings, applicability of local certificates, required output and current contracts. Even a textually clean merge may need reconciliation. Git's common ancestor can help explain a move-versus-copy conflict, but is optional evidence; ordinary builds must also work from source archives and shallow/history-free copies. No custom merge driver is required.

## Files and ownership roots

Retain the existing directory shape:

```text
app/
  App.can
  can.gen.toml                    # generation preferences
  can.generated/
    g-<full-id>/
      unit.json
      implementation.js           # when required
      style.css                   # when required
      contributions.can           # when required
      assets/                     # owned assets when required
  .can/gen/                       # ignored operational state
```

The app/package's defining output root is resolved once from the selected compilation scope and passed through its checked source graph. The default app root is the selected entry file's directory; an explicit root allows source files to move within that app without moving the output store. Dependencies use their defining package root. An unresolved or conflicting root diagnoses; no search through arbitrary ancestors or another checkout's outputs is allowed. This is compiler invocation/module resolution, not a new authored source registry.

Resolve an ID in its defining output root. Internal maps must retain that owner-root qualification instead of merging unrelated roots by bare `u1` or any other bare ID. New random IDs reduce accidental collisions, but do not authorize ignoring duplicate definitions, copied roots or incorrect lookup. No absolute machine path participates in persisted identity or portable fingerprints.

Keep stable ID folders rather than semantic folder names. Inspection/editor navigation can display `App → ItemTile → renderer` and open the concrete file; that view is derived, not a second persisted index. Rename a declaration without renaming implementation paths or maintaining a path pointer. A semantic path remains a reasonable alternative if manual folder browsing later proves more valuable than this simplicity.

Retain the existing `unit.json` carrier as the sole persisted binding record for its unit, adjusting its association semantics instead of adding a lockfile. Keep the record/ABI version, identity, locator/local evidence, any genuinely required saved interface facts, and truthful generation provenance/original output hashes. Required compiler-visible contributions and legacy declaration contracts must remain until their existing owner can supply them correctly. Derive current owner, kind, source location, use sites and authorization from the checked declaration; a stored locator claims an association but cannot grant authority. Recorded generation-time contract facts are evidence, not a second declaration of authority.

Whole-file revisions and byte spans belong in temporary captures or historical diagnostics. The normalized local locator/certificate is long-lived association evidence, not the unit identity. A move/rebind can update that evidence while preserving the ID. Do not rewrite records merely because a file was formatted, a model preference changed or current code was manually edited. Record actual provider/model identity only when known; never commit credentials or local executable paths.

Specify UTF-8/LF checkout rules for the generated text formats through repository attributes, rather than relying on each machine's newline settings; preserve binary assets as bytes ([Git attributes](https://git-scm.com/docs/gitattributes)). Do not normalize arbitrary assets or promise identical final bundles across different compiler/toolchain versions merely because their generated source is identical.

## Build validity and generation freshness

These are independent facts:

| Fact | Meaning and consequence |
| --- | --- |
| Association | The external binding resolves a source slot uniquely to its owned saved group; missing/duplicate/ambiguous bindings diagnose |
| Compatibility | Current implementation passes required checks against current source and target contracts; incompatible or missing required outputs fail |
| Prompt drift | Prompt text differs from the recorded generation/reconciliation baseline; report it, but compatible saved code remains a build input |
| Manual modification | Current bytes differ from original generated hashes; use and validate current bytes without falsely attributing them to the generator |

Changing a prompt never silently changes behavior. Explicit generation or direct editing changes the implementation. A no-AI reconciliation may record a reviewed prompt baseline without rewriting historical generation facts. Such an acknowledgement is not proof that natural-language intent is satisfied.

Changing runner/model preferences affects future attempts. A compiler/target upgrade checks compatibility; a version change alone is not permission to regenerate. New compatible uses of a named definition reuse its implementation. Changed contracts, effects, permissions or key semantics retain their existing compiler/runtime and schema-migration requirements.

Builds need Can and their ordinary runtime dependencies, but no generation CLI, login, model call, MCP generation server or prior `.can/gen` history. Missing inline styles should diagnose just like other missing required generated output; the present synthesized-empty-style exception must be removed if this proposal is adopted. This is an explicit behavior change, not a claim that the current compiler already enforces it.

## Publication and recovery

Keep MCP content submission, isolated candidates, existing validation, attempt fences and cooperative leases. Long-running generation holds no write lease. Full retry still regenerates every prompt in the active app closure and accepts the complete validated candidate set together.

Every compiler entry point must discover and freeze one consumed source/output closure under the same reader coordination. Snapshot acquisition covers source/group membership as well as existing file bytes; if discovery changes before capture, retry that capture. Refuse unresolved journals while leases are held, then compile/check/emit exclusively from the frozen bytes. Do not re-resolve saved groups from live disk during emission.

Extend the current journal to describe exact old and new membership: additions, replacements **and deletions**, including binary assets. Candidate completeness and promotion must distinguish full replacement from scoped patch/refinement; absence in a patch is not an instruction to delete unrelated files. A full replacement removes obsolete owned files only as part of its declared complete replacement set. Rollback restores bytes and absence exactly. Read Git blobs as bytes, never through text decoding.

Acceptance checks the captured source, contracts, current bytes and attempt fence before publication. Before journal commit, recovery preserves/restores the complete old set; after commit it finishes the complete new set. Unexpected bytes preserve conflict material. These guarantees cover participating readers/writers; a new ID or directory layout does not provide filesystem compare-and-swap against arbitrary external editors.

Keep candidates, prior rollback state, journals, leases and execution reports ignored. Orphaned current groups are reported, not automatically deleted by build, source edits or cancelled generation. Explicit cleanup can remove verified unreferenced groups, preserving retained recovery needs. Generation does not automatically commit to Git.

## Git changes and migration

Commit clean source, accepted code/assets and their external binding records together. Unrelated branch additions receive unrelated random IDs and ordinary independent file changes. Two branches editing the same implementation use normal Git conflict resolution and deterministic validation afterward. A textually clean merge does not establish behavioral acceptance, just as it does not for handwritten code. Do not introduce a custom merge engine to imply otherwise.

Validate the actual staged tree or a clean checkout when establishing that a commit is buildable; ignored local state and unstaged files must not conceal missing committed inputs. Source archives must also work, so ordinary compilation cannot require Git history. Generation receipts record history, not an immutable approval seal over all future manually edited bytes.

Migration is deterministic and requires no model calls:

1. Discover existing bindings and current consumed groups without mutating them. Preserve handwritten edits and original provenance separately.
2. Upgrade unambiguous external bindings with qualified selectors and local certificates where needed. Retain valid existing IDs and directory bytes; new allocations use random IDs. Root-qualified lookup prevents legacy counters from colliding across distinct owner roots. Ambiguous legacy bindings need a deliberate bind/fork; do not guess by proximity or prompt similarity.
3. Stop using whole-file SHA/span as permanent duplicate disambiguation. Keep necessary legacy record fields readable during the transition. An ID or root embedded in implementation-specific content must be reconciled by its owning mechanism before any rekey/move; never rewrite arbitrary JS strings speculatively.
4. Verify the migrated bindings with saved files, without generation tools or source annotations. Replace the affected metadata through the existing coordinated edit boundary. Ambiguity leaves that set unchanged and names the exact decision needed.

The implementation would remain with the existing compiler syntax/intake/codegen and Cloudflare generation owners. This proposal does not create another execution plan or reopen completed BGI criteria; a later authorized implementation should extend the existing plan at this changed scope.

## Corroboration and uncertainty

The original investigation used three independent architecture, identity/merge and lifecycle agents, one cross-comparison round, source inspection and one direct TypeScript association check. The following findings remain relevant after the user rejected its source-ID recommendation; unchanged checks are reused.

| Finding | Corroboration and scope |
| --- | --- |
| Sequential branch allocation collides | Both identity and architecture lanes found the allocator; direct calls to `nextUnitId([u1,u2])` returned `u3` twice ([allocator](../../../../packages/cloudflare/src/generation/association.ts)) |
| Duplicate-node binding is revision-fragile | Identity lane identified whole-file revision matching; the direct check returned retained/retained before an unrelated revision change and ambiguous/ambiguous afterward ([association](../../../../packages/cloudflare/src/generation/association.ts)) |
| Readable directories need another locator rule | Architecture initially preferred semantic folders, then withdrew that part after comparing rename/pointer maintenance with direct ID lookup; fixed folders remain a judgment about simplicity |
| A second module ID is unnecessary | Identity initially proposed one, then withdrew it: existing checked ownership plus root-qualified unit lookup covers the stated requirement |
| Direct compile does not use the guarded capture path | Lifecycle inspection and coordinator source read find live source/group reads and Then re-resolution ([CLI](../../../../compiler/src/cli.rs)); mixed-generation execution was not reproduced |
| Exact rollback needs absent files and binary bytes | Lifecycle and coordinator source reads find byte-only replacement entries and text-encoded Git rollback ([journal](../../../../packages/cloudflare/src/generation/journal.ts), [controls](../../../../packages/cloudflare/src/generation/controls.ts)); no crash/rollback experiment was run |
| Bare-ID cross-root maps and empty inline fallback need correction | Identity/lifecycle reads identify the mechanisms ([CLI](../../../../compiler/src/cli.rs), [intake](../../../../compiler/src/analysis/generation_intake.rs)); no cross-root artifact corruption was reproduced |

The original, now superseded source-ID comparison used three independently worded equivalent [Choice](https://docs.typesafe.ai/primitives/choice) requests. Exact requests/distributions remain in request 1, request 2 and request 3. Model: `jev-1.13.0`; 7,819 input and 691 output tokens, 8,510 total. Its identity advice cannot override the user's clean-source requirement.

| Question | Selected choices in requests 1 / 2 / 3 | Reported confidence |
| --- | --- | --- |
| Storage layout | Semantic companions / fixed editable groups / semantic companions | .26 / .42 / .27 |
| Binding | Source slot ID in all three | .36 / .41 / .40 |
| Freshness | Separate compatibility and drift in all three | .99 / .93 / .87 |
| Publication | Editable files with coordinated transaction in all three | .63 / .52 / .49 |

The identity and lifecycle agents then independently reconsidered external records versus a sole-authority per-source binding map. Their one cross-comparison identified the actual tradeoff: per-unit certificates suffice for unchanged-region preservation and explicit reconciliation; a shared structural baseline can preserve more subregions automatically during local edits but adds a carrier and reconciliation machinery. The lifecycle agent favors a per-source map if that broader automation is required; the identity agent accepts per-unit records for the finite scope here. Neither claims arbitrary identity can be inferred from final source text.

The revised consultation fixes clean source as nonnegotiable and compares the strongest per-unit, per-source, strict-locator and global-map alternatives against the same finite cases. Clean-source request 1, request 2 and request 3 preserve all inputs/responses. All select per-unit records: probabilities .84/.94/.90, reported confidence .80/.92/.87. Model `jev-1.13.0`; 4,238 input plus 177 output tokens, 4,415 total.

These are advice, not votes or measured reliability. Choose the existing per-unit carrier because it satisfies the declared preservation/reconciliation scope with fewer mechanisms and local merge conflicts. Implementation qualifies normalized CST intervals with source edits, formatting/comments, duplicate insertion and conflicting records; the finite results are recorded in the execution view. Excessive observed rebinding would justify the separately described per-source baseline; it is not an unlimited prerequisite to this design.

## Acceptance scope

The execution view records the checks actually run, including retained results for unchanged lifecycle behavior. These outcomes define the scope; they do not promise inference of arbitrary text edits:

1. A relocated clean checkout and source archive consume identical saved JS/CSS/contribution/asset bytes with generation tools/credentials absent; no build writes tracked files.
2. Formatting/comments and edits outside a uniquely anchored recorded interval preserve its two distinct identical inline slots. Relevant insertions/changes with ambiguous correspondence diagnose locally; no ordinal slides or whole-file-revision rebinding.
3. Independent branch additions merge without allocator collisions; multiple owner roots containing legacy `u1` cannot overwrite each other's consumed group.
4. Compatible manual edits build unchanged; prompt drift is reported separately; changed source/target contracts fail precisely without generation or automatic replacement.
5. A failed first generation leaves only external pending binding metadata and an explicit missing-output diagnostic; `.can` contains no generated IDs, magic comments or added persistence names, and no partial/empty implementation is accepted.
6. Full retry, a participating edit, cancellation and interrupted publication expose only a complete captured old/new set to every compiler entry point. Capture includes graph/file membership.
7. Full replacement, scoped refinement and rollback correctly distinguish replacement, addition and deletion, including byte-identical binary restoration and preserving unrelated files.
8. Migration preserves current output bytes and truthful provenance, consumes no AI and refuses ambiguous ownership without guessing.
9. Can-aware moves retain IDs and code; copies fork current bytes into independent groups. Plain ambiguous moves/copies and textually clean but conflicting merges name precise reconciliation actions without AI. Tests also run without Git history or an editor extension.
