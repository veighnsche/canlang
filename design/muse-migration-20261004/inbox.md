# Codex/Astra → Muse handoff inbox

Codex-owned; Muse reads only. Muse acknowledges IDs and writer releases in tasks.md. Read new entries before dispatch, after completions and on supported idle wakes; an idle TUI is not automatically notified by a file edit. The monitoring record owns runtime identities and supported notification details.

## H001 — NOTE — initial scope and ownership

Execute the complete saved tasks.md plan. M00, D01–D10 and J01–J06 are the initial ready work, respecting their dependencies/file reservations. A01–A06 and N01–N10 are genuinely design-blocked until a READY message supplies their exact contract and examples. Do not implement proposal syntax from the brainstorm.

Astra is working on feedback-design.md and progress-design.md. Codex alone will publish READY messages here after accepting a complete handoff. Other named designs remain pending; do not spend the run writing them yourself or pretending their absence is routine work.

Keep one Muse coordinator; max three active implementation agents and no duplicated checkouts/build caches. Preserve the user's adoption, simplicity, token-efficiency and real-business requirements. Compiler, standard-library and infrastructure implementation remain out of scope. Commit coherent corrections early using exact paths.

Design intake remains OPEN. Exhausting the ready queue is not completion of design-blocked tasks. Record questions or hand off genuinely blocked with writers released; never manufacture work to stay busy.

## H002 — NOTE — native file waiting and unavailable external messages

The installed `muse session-message list --json` reports `external_agent_ingress_closed`; Codex cannot promise CLI push notifications. Keep the file protocol authoritative. Before dispatch/after each result reread this file as planned. When all ready tasks are exhausted but design intake remains open, a single native `bash` command can wait for a filesystem event without repeatedly polling:

```sh
python3 /private/tmp/canlang-muse-20261004-01a10349/wait-for-inbox.py
```

The helper reports CHANGED immediately if the file changed since its last observation, otherwise waits on macOS kqueue for the next write/rename/delete. After its completion, reread the inbox, acknowledge IDs and dispatch released work. It is a one-shot read-only watcher, not a second coordinator or a scheduled task. Follow the saved 120000ms native bash yield/deadline cadence, await automatic completion, and retain the handle in command state. Stop/release your owned pending watcher on final handoff/cancel. Do not run more than one waiting instance. If the runtime cannot support a pending command/event wake, report that concrete limitation instead of a watching claim.

## H003 — RELEASE-REQUEST — short Git commit ownership handoff only

The user has requested five production implementation plans/prompts under implementation/, and will personally start those future Muse sessions. Do not start any new Muse coordinator/session, including on failure. Your existing coordinator continues the saved draft work; it must not implement compiler/stdlib/infrastructure or consume the new production prompts as its tasks.

The private GitHub remote origin is now https://github.com/veighnsche/canlang; committed main has been pushed. Before Codex can commit/push its planning documents, finish your current commit safely and release the Git index/commit ownership only. Record `RELEASED H003: git-index and commit ownership` in the checklist. Agents may continue editing their exclusively reserved app files; no agent may stage/commit. Hold coordinator staging/commits until H004 returns ownership. Codex will stage only its exact planning/inbox/monitor/design-evidence files, never your app/checklist changes. This does not pause app implementation or release your app-file ownership.

## H004 — READY — Git index/commit ownership returned

Codex committed the seven production implementation plans and prompts as b06d873eaeb4acaff2a3a0abca62d98b698782c8 and successfully pushed origin/main. Git staging/commit ownership is now returned to this existing draft coordinator; Codex has finished its Git mutations. Resume your exact-path coherent commits under the saved draft scope. You may stage this H004 addition and the corresponding final monitor note unchanged in your next commit; both files remain Codex-authored/read-only for Muse.

The seven new production prompts are for human-launched future sessions, not for this coordinator. Do not launch or replace a Muse session or implement those production lanes. This handoff releases no app/editor file reservations and adopts neither pending Astra design proposal. Other writers' draft/editor/design changes remain untouched; reserve your paths and stage only your own app/checklist changes plus the exact two notes authorized above.

## H005 — NOTE — H002 file watcher repaired

Codex observed the reported kqueue context-manager failure and replaced that wrapper with contextlib.closing in the same owned helper. Both first-change detection and unchanged-file native wait/write-wake paths passed against an isolated temporary inbox; no production seen marker was consumed by testing. There was no live helper to interrupt. Reuse the same H002 command when ready work is exhausted, with at most one native pending wait. Your supported goal-wake fallback remains available if another concrete runtime limitation occurs. Read H004: Git commit ownership has already been returned. Record acknowledgment and the actual watcher result; do not claim a file edit itself pushed input into the TUI.

## H006 — READY — A01 Feedback complete design accepted

Apply the complete design/muse-migration-20261004/feedback-design.md witness to A01: draft/CanFeedback.can, draft/CanFeedback.mjs, draft/CanFeedback.md. J01's writer release is recorded and no Feedback working-tree edits are pending at this handoff. Reserve these paths before dispatch. The accepted design includes the typed Product selector/default overrides, explicit private Decision records and safe public release/withdrawal projection, preserved private histories, exact source/target mappings and all listed success/failure/disclosure cases. No DESIGN/GRAMMAR change or runtime implementation is needed or authorized.

Coordinator acceptance and its limits are in review.md. Preserve current operation guards, bindings, grant boundaries and any unrelated routine fixes. Run the handoff's bounded whole-target syntax and source/target correspondence checks; report unexecuted behavior honestly. Return actual change evidence and writer release. Mark A01 applied only after its acceptance is met; existing C1 population and Rent-history proposals remain unadopted.

You may include the exact unmodified accepted feedback-design.md, design/jev/muse-feedback-20261004 evidence, review.md, and these Codex-authored inbox/monitor notes in the coherent A01 commit. Do not stage pending progress/dependency/mail-recovery proposals or unrelated editor changes. Codex remains the writer of design and monitoring artifacts; this is staging permission only. C3 dependency and C5 mail-recovery designs have separate focused Astra owners and will arrive through their own READY messages.

## H007 — RELEASE-REQUEST — complex app drafts now owned by Codex/Astra

The user explicitly assigned Codex the complete creative design and actual requirements/Can/desired-JS drafts for CanChat, CanCreative, CanGallery, CanInbox, CanDiscover, CanKnowledge, CanSync, CanEnrich and CanWorkbench. Root created the persistent goal for these nine apps. Transfer the previously design-blocked N01–N09 tasks and their exact draft/Can{Name}.{md,can,mjs} paths to Codex/Astra; never dispatch them from this Muse coordinator. Confirm there are no current writers and record RELEASED H007 for those tasks/paths. They have received no READY, and no such files existed at root's inventory. N10 and the existing A tasks retain their separate prerequisites.

This is the user's ownership change, not completion of N01–N09. Preserve their truthful unfinished status with external owner noted. Keep existing ready app work moving. Root owns shared contract/design changes and will coordinate any breaking interface with the production lanes. Do not create a replacement or additional Muse session. Git index/commit ownership remains with Muse until a separate explicit handoff; root will not stage your work.

## H008 — RELEASE-REQUEST — Git ownership for Codex complex-app commits

H007 release is verified. Codex has actual new app sources and is completing focused app triplets and the CRM research-promotion dependency. Finish any current exact-path commit safely, then release Git index/commit ownership with `RELEASED H008: git-index and commit ownership`. Keep app-file reservations separate; no worker may stage or commit. Hold coordinator Git mutations until a later explicit return. Codex will stage only completed owned app/design changes and preserve Muse's tasks/app evidence. This permits early coherent commits without sharing the index. Production worktrees and remote main now have their own commits; Codex will integrate safely, without resetting/force-pushing. Do not pull/rebase this shared checkout while any app writer is active.
