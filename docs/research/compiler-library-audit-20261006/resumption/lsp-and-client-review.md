# Released LSP repair completion and independent client review

Implemented ED-R04 + ED-R08 + both ED-R05 options in compiler/src/lsp/server.rs and lsp/output.rs; permanent witnesses in compiler/tests/lsp_typed_output.rs and one versioned-profile capability correction in compiler/tests/ide.rs. No public backend trait, query API, source retention/workspace design or dependencies changed. Root-requested RealAnalysis diagnostic sort now delegates to Diagnostic::canonical_cmp (depends on root's OUT-R02 comparator).

Close returns one typed empty diagnostic publication for the removed live document, removes its queued work and preserves other URI work. Pending tasks now carry the existing immutable SourceId alongside URI/version; pump requires ready/not-exited plus matching current source/version. Shutdown clears queued tasks. Reopen cannot revive a closed task, and even a reused version with distinct source snapshot publishes once. This uses existing source identity rather than a parallel epoch registry.

References includeDeclaration=false removes exact declaration URI/range locations from the backend's ordered references; true is unchanged. Declaration and use positions have actual process witnesses. The existing public LanguageAnalysis callback remains unchanged.

Edit carrier selection is negotiated only by capabilities.workspace.workspaceEdit.documentChanges=true. Capable clients receive existing ordered/versioned documentChanges for rename and actions; absent/false capability receives changes. The ordered changes serializer preserves authored URI spelling and first group order, avoiding URL normalization or nondeterministic HashMap order. All payloads still use typed serialization, with one private wire union and no duplicate grammar/parser.

Verification after final server changes:
- cargo test --manifest-path compiler/Cargo.toml --locked --offline --lib lsp:: : 30 passes, no warnings.
- Selected integration suites authoring (30), b3_authoring_join (3), b3_s4 (4), ide (32), lsp_admission (26), lsp_typed_output (7): 102 passes, no warnings/skips.
- git diff --check for four owned files: clean.
- Real processes cover close/reopen, absent/false/true edit support, includeDeclaration false at definition/use, true control, Unicode/CRLF and exact opaque URI identities. Public batching covers close/reopen, unrelated URI order, source identity under reused version and shutdown.

Correctness growth is intentional and should be counted honestly; capability negotiation and currentness are required mechanisms. No production reduction is claimed. Retirement removes URI/version-only queued identity, close-without-publication, unconditional documentChanges and ignored reference option. Recommended reviewable commit grouping: one server options/currentness commit including associated tests, or split close/queue vs option negotiation with tests staged accordingly. Root owns docs/DECISIONS/counts/commits. Canonical comparator delegation belongs with root's output determinism change if commits are split.

Independent clean-room client source review:
- One live owner map contains host object/version plus monotonic wire version. Each open/change installs a fresh owner; close/death/stop retire it. This distinguishes same-host-version reopen without exposing a new wire epoch field.
- requestDocument captures the owner and checks identity, host revision, running state and cancellation before conversion. All seven providers use this owner. Versioned edit targets compare wire versions using the same map.
- Cancellation registration precedes wait, cancellation settles immediately and sends the standard notification, late replies lose their pending owner, success/stale/cancel/death paths dispose listeners. Source has a second check for synchronous registration races.
- Completion kinds map protocol ordinals to actual host enum identities; the ambient values match the independently defined host enum fixture.
- No actionable defect found in the released single-document profile. Startup/workspace policy, arbitrary cross-file unversioned target races and actual GUI/application remain separate qualification.

Independent replay compiled current sources in isolation with installed TypeScript5.9.3 to /private/tmp/can-editor-independent-review, then used CAN_CLIENT_OUT and the newly built actual compiler in test/client-currentness.cjs. All five named groups passed: stale/closed/reopen diagnostics and clears; all seven pre-cancelled providers; type/variable/keyword host identities; all seven stale/live-cancelled providers; exact Unicode/CRLF rename/action host-stand-in application.

Important existing omitted compiler workflow: the capabilities fixture's `set task.completed=true` occurrence is absent from reference/rename output. The new client witness explicitly asserts only the offered declaration and task.title edits and records that limitation. This does not invalidate currentness/enum repairs but prevents a claim of complete rename behavior. Root notified; release a separate bounded query/resolution ownership repair with full declaration/read/set-target controls. Client monotonic wire guarantee and arbitrary third-party server queue guarantee must remain distinct.
