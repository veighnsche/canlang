# Review business policy

Review access as source-derived behavior with the people who own the business process. For each operation, identify who may call it, which records they may act on, what facts they can read, and what conditions reject the change. Confirm that the role vocabulary maps to real responsibilities and does not encode a temporary UI layout.

Walk both allowed and denied cases. Check direct CRUD exposure, internal calls, pages, exports, MCP tools, and replay behavior. Ask what an unauthorized caller can infer from error differences, timing, counts, or a success receipt. Verify that a hidden field is also protected in query dependencies and output projections.

Finally inspect owner invariants, locks, retention, stale versions, and external effects. A policy review is not complete if it considers only the browser. Use [authentication](01-authentication-and-teams.md), [operation permissions](02-roles-and-operation-permissions.md), and [read policies](03-read-policies-and-field-access.md) as the semantic owners.
