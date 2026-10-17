# IDE workspace mechanism advice

These are implementation consultations for the explicitly requested project-wide IDE slice, not language proposals or permission gates. Context was verified against the current CLI/checker, resolver module metadata, LSP document ownership and custom VS Code client. Each choice was asked three independently worded, equivalent times with balanced alternatives.

- Requests 1–3 compare preopening/synchronizing reference targets before standard rename, custom content-hash carriers, and response-time disk checks with null document versions. All three chose `preopen`, reporting confidence 1 and probabilities `{preopen:1, hashes:0, diskedits:0}`.
- Requests 4–6 compare declaration/import/composition closure including reverse consumers, whole-workspace checking, and a required new project manifest. All three chose `closure`, reporting confidence 1 and probabilities `{closure:1, all:0, manifest:0}`.

There was no disagreement to investigate. Reported certainty is model advice, not proof; the actual code and focused protocol/editor checks establish behavior. The first consultation encountered restricted network access; the preauthorized call then succeeded with network access. No secrets are saved.

The chosen implementation discovers local source candidates, isolates folders by longest owning root, and checks only the current owner connected through declarations/imports/composition. Unrelated same-name apps remain separate. Imported provider ambiguity is diagnosed and never resolved by filename proximity. Hidden directories and generated/dependency directories are excluded; `draft` remains an ordinary source directory. Intake exceeding 4096 files, 16384 directories or 64 MiB per root fails visibly instead of returning a partial source set.

The server refuses any rename with a closed target and requires versioned document changes for cross-file edits. The VS Code provider first obtains references including declarations, opens and synchronizes those targets, then asks for rename and verifies every returned version. A changed target set that still includes a closed file is refused atomically.

Remaining limits: ordinary LSP clients must synchronize all target documents to perform a cross-file rename; no custom closed-file hash protocol is supplied. Files outside declared roots retain single-file analysis. Symlinks are not traversed during discovery. Genuine imported provider ambiguity requires selecting unambiguous workspace roots or correcting declarations. Metadata caching stores only names and byte offsets under exact path/content hashes; checked semantic facts and returned SourceIds are recreated for the current database, root and catalog.
