# ED-R09 finite editor lifecycle qualification

The selected existing client/extension lifecycle is qualified through the unmodified compiled modules and real process callbacks. No workspace, catalog reload, automatic reconnect or other-host support is selected here. VS Code GUI rendering/application remains outside this host stand-in profile.

Expected outcomes were specified from the existing one-child lifetime, startup-handshake, restart-on-reopen and bounded shutdown contracts before asserting results:

| Input | Required outcome |
| --- | --- |
| Delayed initialize, concurrent starts, document events during startup | One shared handshake; no document/provider traffic before successful initialize and initialized; extension replays current open-document bytes once |
| Initialize RPC error, process/spawn failure, failed write, no response | Startup rejects; no initialized/document replay; dispose diagnostics once; spent client refuses reuse |
| Overlapping manual/configuration restarts and open during retirement | Retire one child, then create one replacement; latest open text is replayed |
| Child crash followed by open | One failure notification; fresh child with current text; no retry loop |
| Cooperative shutdown | Send shutdown, then exit/end stdin; child exit settles stop immediately; outstanding requests settle null immediately at stop admission, before any response/deadline; intentional exit is silent |
| No shutdown answer / ignores exit | Existing two-second phase deadline ends cleanup, forcibly terminates child; no indefinitely pending provider request |
| Synchronous request/notification write exception / asynchronous EPIPE | Reject failed request; retire unusable transport, discard unsent revision ownership, and settle other pending work immediately; no unhandled stream error |
| Deactivate during queued restart | Return cleanup promise; prevent a late replacement process |

`before.json` observes four defects on the separately compiled pre-change HEAD source: didOpen before initialize completes, RPC initialize error still resolves startup and sends initialized, overlapping restart creates three children, and cooperative exit does not settle stop immediately. `before-observe.cjs` reproduces that receipt with `CAN_CLIENT_OUT` pointing at the baseline compile. The timeout and signal witnesses exercise bounded fault cleanup rather than making a new availability or reconnect promise.

Repairs keep one live revision owner, wire reopen epochs, shared provider cancellation and VS Code completion identities. `ready` separates admission from process attachment; one startup promise rejects invalid handshakes and a local ten-second initialization deadline cleans up a silent child. One shutdown promise settles on observed exit or its existing two-second phase deadline, settles pending work and uses SIGKILL for stragglers. The extension coalesces pending restarts, ignores obsolete client callbacks and returns deactivation cleanup.

[verification.json](verification.json) records exact commands, source/test hashes, platform and actual compiler binary hash. Raw results are in `check-0.txt` through `check-4.txt`: strict TypeScript compile; 14 controlled callback groups; 6 actual OS subprocess groups; 11 existing startup groups; 5 existing real-can currentness/provider groups. Tests contain the assertions rather than counting a body skip as a pass. The OS controls use real timer deadlines, real pipes, a deliberately unresponsive peer, SIGKILL, and a Python peer that closes stdin to cause real EPIPE. The harness observes/reaps the killed children; client stop's promise ends cleanup at the force-kill deadline and does not promise waiting indefinitely for OS reaping.

Two fixture issues were corrected before final receipt: the lifecycle stand-in lacked CompletionItemKind, and directly closing stdin's fd in a Node peer aborted before its close marker; the EPIPE peer now closes stdin in Python. The existing startup fixture now awaits handshake admission before its document/death assertions and uses inert timers for the startup-only mocks. These are harness corrections, not product findings.

Decision text for the shared owner: Accept finite ED-R09 existing lifecycle repairs: gate editor traffic until initialization succeeds; reject failed initialization and clean up silence after ten seconds; coalesce overlapping restarts; complete stop on child exit or existing bounded shutdown deadline; settle pending requests on transport retirement and prevent restart after deactivation. Preserve user-paced restart-on-reopen. Actual OS process/callback and real-can consumer checks pass; GUI, other OS hosts, workspace/catalog and automatic reconnect guarantees remain unselected.

Independent review reproduced delayed pending-request settlement on stop and unsent revision ownership after a synchronous didChange write exception. Both are corrected: stop settles existing pending work before registering shutdown; failed writes retire the transport/document map and other pending work, while the initiating request rejects. Timing regressions assert settlement flags without advancing virtual time, so an unresolved mock promise cannot silently end the suite.
