# Selected documentation context used by Variant D

Observed lookup date: 2026-10-04 UTC. Django documentation version 5.2; MCP SDK pinned v1.26.0. This file preserves concise paraphrases of the selected context actually consumed. `supplied-docs.json` records URLs, observed rendered line ranges and local input hashes. Opening a document URL sometimes returned only metadata; those initial openings are not treated as reading full documents. Reproduction can open the cited URLs and selected ranges. Django line ranges are web-rendered and may change; SDK source tags are fixed. Full retrieved web bodies were not downloaded or silently provided to the generation subject.

## Pinned request context

Generate one draft app for 25 company staff, three departments and 500 records. Browser forms and authorized MCP share business operations. Employee-derived ownership/department, private ownership scope, narrow manager reads, no finance/operation scope escalation, open/archive evidence and version conflicts. Search/filter/responsive accessible forms/list; scoped export; CSV invalid/duplicate preview, explicit correction/exclusion and partial outcomes. Save app source/tests/wiring plus assumptions/provenance; do not implement a platform or read findings/other variant.

## Django auth (selected lines 54–137, 264–414)

Default Django User supplies username, email and hashed password. create_user/set_password are framework password contracts. authenticate checks configured backends, while LoginView supplies normal login. Session/authentication middleware populate request.user. login_required restricts anonymous requests but does not independently test is_active, so services also fetch current active user and membership. Application object scope must be authored rather than inferred from generic staff flags.

## ModelForm (121–128, 179–206, 225–244)

Model fields derive form required/optional flags, labels and help text. is_valid triggers form and participating model validation. Explicit Meta.fields chooses mutable input. Instance-bound forms modify their instance during validation; failed validation may leave the instance inconsistent. The service validates a fresh form and applies validated fields to its freshly locked object, rather than treating the browser's bound instance as authority.

## Transactions / querysets (transactions 99–151; querysets 1161–1190, 2555–2560)

atomic scopes commit/rollback and can nest using savepoints. IntegrityError should be caught outside the inner atomic block. select_for_update requires a transaction on supporting databases, locks selected rows and behaves differently by backend. SQLite silently omits row locks; PostgreSQL provides the chosen production contract. TestCase wrapping does not establish true lock behavior, for which TransactionTestCase would be required. Q expressions combine access conditions.

## Signing (139–205)

TimestampSigner adds age-verifiable signatures. signing.dumps/loads sign JSON data; loads can enforce max_age and raises BadSignature on invalid signatures. The app adds its own salt namespace, current user validation and password-session-hash comparison; signing itself does not confer department permission.

## Async (130–155, 174–181, 200–269)

Django transactions are not supported as async ORM transaction blocks. Encapsulate the transaction/ORM calls in a single sync function and use asgiref.sync.sync_to_async. Calling sync ORM directly from a running event-loop thread can raise SynchronousOnlyOperation. thread_sensitive=True preserves a safe threading context; pass plain results, not DB handles, across the boundary. asgiref is a Django dependency. Disable persistent async DB connections.

## MCP SDK (README 282–303, 411–500, 895–958, 1072–1206; server.py 262–281, 320–323, 414–469; func_metadata.py 67–86)

FastMCP registers typed tools through its tool decorator and supports structured dictionary outputs. Its run transport accepts stdio, SSE or streamable-http. Direct execution supports subprocess use; production HTTP examples have different auth/lifespan obligations. SDK resource-server authentication expects a TokenVerifier and a separate authorization-server contract; the app does not pretend a Django LoginView is that OAuth server. FastMCP async dispatch directly calls a synchronous tool function when it is not async, so all app tools are async wrappers awaiting the one thread-safe Django call adapter. The chosen stdio client supplies an app bearer token via a protected process environment, not via a client-selected principal argument.
