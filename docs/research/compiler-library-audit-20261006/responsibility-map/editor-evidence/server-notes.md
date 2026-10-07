# Step11 server lifecycle primary view

Seventeen finite server duties cover envelope/state admission, initialization/capabilities, client-owned open text, full updates/versions, queue/pump identities, diagnostics/close, fresh queries/versioned edits, cancellation/shutdown, stdio disconnect, process catalog/workspace boundaries, single-file semantics and long-session history. Only these two evidence files were edited; no tests/builds/probes were run by this worker.

Official LSP3.17 primary-source URLs and bounded normative summaries are saved in `server.json`. The rendered specification returned a navigation shell, so the actual official gh-pages markdown/includes were read. Protocol obligations are separated from invalid-client robustness: decreasing/equal change versions and duplicate opens violate client rules; full synchronization does not promise incremental edit support. Ignoring cancellation notifications is allowed for a synchronous implementation.

The public queue is not an asynchronous executor. Production reads a message, answers it synchronously, drains diagnostics synchronously, then reads again. Version-based task skipping can be probed through public batched Server calls, but real burst edits do not establish background cancellation/coalescing. Close/reopen with the same version before a public pump lets an old queue entry analyze the new buffer again; it does not publish stale old text.

A valid close does not send a server diagnostic clear. RealAnalysis is single-file, so the official VS Code single-file diagnostic rule is relevant. The bundled client clears locally on close, which may mask the server gap. Root must retain the distinction between wire behavior, protocol guidance and actually visible editor state.

Catalog and query scope are explicit limits: the backend loads its catalog once from process environment/cwd, ignores initializer workspace roots and workspace invalidation notifications, and analyzes one current file per query. No project graph, cross-file references/rename, per-root catalog or live reload is implemented or advertised. A trait result carrying another URI does not prove production cross-file support.

SourceDb keeps every distinct historical buffer; close removes only its live document. Equal-content live changes reuse SourceId, while reopen after close appends even identical text. More importantly, real diagnostic/action lint reparses every retained SourceDb revision before filtering current-file results. Fresh query snapshots also repeat frontend work without cache. These are concrete long-session resource/cost leads, separate from wrong-current-version diagnostics. Root will qualify process/resource witnesses.

Remaining evidence work: root fresh transcripts/callback observers and process/resource review. No new implementation, policy, JEV or blanket protocol acceptance is implied.
