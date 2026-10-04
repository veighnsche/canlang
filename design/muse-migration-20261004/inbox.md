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
