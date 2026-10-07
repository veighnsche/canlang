# C09P bounded position/path repair release

Sol medium independently confirms 27 actual-source/rlib vectors and fixed proposals, following low-worker escalation for four explicit contract failures. Retain current small mechanisms and add no line-index/path dependency; full text indexing has no demonstrated inverse-query benefit. Source.LineIndex remains byte/UTF16/CRLF policy owner; no new coordinate convention or snapshot index is introduced.

Sole writer owns compiler/src/ide/queries.rs, compiler/src/docs.rs, compiler/tests/ide.rs and compiler/tests/docs.rs; receipt only pass9/correctness/positions. Source.rs and source-map code stay separate.

P09-1: inverse offset_at_position strips trailing CR only when line_end actually points to LF. Bare EOF/internal CR counts as an ordinary scalar even though lexing may diagnose it. Preserve valid CRLF exclusion, missing-line None, EOF/trailing-LF lines, inside-surrogate backoff, UTF16 counting and line-end clamp. Extend independent existing IDE vectors; verify current source LineIndex roundtrips at addressable scalar boundaries.

P09-2: lexical_normalize must not pop an already retained ParentDir when processing another ParentDir. Preserve existing ordinary component cancellation, literal leading parents beyond start, empty dot, and existing absolute-root literal-parent policy; do not replace these with path-clean root clamping. Verify private lexical fixed cases and public missing-relative-root external identities; qualify current absolute-root/missing-path/symlink regression paths. Production docs roots are normally absolute; public relative-root defects are identified without claiming their CLI reachability.

Broader public relative-root external:absolute wording and missing-suffix symlink identity remain separate boundaries, outside these two corrections. No path canonicalization expansion, nonUTF8 ownership change, dependency, or cross-host claim. Sol low starts the released narrow edits; source-policy conflicts return to Sol medium. Root owns independent review/checks/commits.
