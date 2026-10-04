# CanInbox focused draft verification — 2026-10-04

Scope: `draft/CanInbox.can`, `draft/CanInbox.mjs`, `draft/CanInbox.md`, the owned Inbox design and this evidence directory. No shared docs, compiler/library/provider implementation, Git staging/commit or Muse session was changed by this assignment.

Run from the repository root:

```sh
python3 design/jev/complex-inbox-20261004/check-draft.py
```

[Machine-readable results](static-verification.json) retain actual commands/exit codes, projection exclusions and the triplet's SHA-256 hashes. The checker performs static correspondence/syntax assertions only; it neither loads the desired standard library nor substitutes mocks to execute app behavior.

| Check | Result |
| --- | --- |
| `node --check draft/CanInbox.mjs` | Pass, exit 0. |
| Full `python3 tools/can_parser.py draft/CanInbox.can` | Expected unsupported new declaration: line 15, column 19, `expected a model field schema`, exit 1. |
| Ordinary-syntax projection | Pass, exit 0: `Parsed 1 .can files (syntax only).` |
| Registry/source static scope | 10 models, 13 scenario handlers, 21 fixture recipes, 15 example blocks including one shared-state sequence, 2 pages. |
| Table cases | 42 source rows; source and target each have the same 15 example blocks. This is authored coverage, not 42 executed tests. |
| Canonical target boundaries | Four trusted handlers take `(c,{event})`; sequence uses `dependencies` and `sequence`; no raw boolean Can `by` string; typed UI arrays use `items`; source descriptions are retained. |

The projection omits source lines 14–18 (judgment and its attached description), replaces the two lines' `delivery(...)` field types with `text` solely for syntax, omits the shared-state example at lines 181–187 and removes the page's `poll=5s`. It does not constitute a type-correct replacement app. The evidence checker regenerates `/tmp/caninbox-business-projection.can` from source each time. The full-source failure and all exclusions are reported, rather than changing the prototype parser or claiming unsupported constructs parsed.

Focused manual correspondence covered all declared policies/locks/invariants, ordered guards/effects, generated judgment descriptor/type references, queue authority and transfer disclosure, bounded quota reservations, delivery association access, input minimization and file limits, frozen reply identity, terminal callback handling, disabled-mailbox reconciliation, UI admission/projection and table/sequence intent. It corrected an `other` fixture enum-name collision, trusted handler signatures, sequence lowering, role metadata, nullable property observation, source descriptions and retained-message mailbox visibility.

Consequential authored examples:

- Exact intake duplicate consumes no new classification budget; conflicting same-source evidence rejects atomically. Exhaustion/disabled sending still retains new mail.
- A 50/0/50 urgency distribution produces fractional expectation 1 without claiming the middle criterion won. A successful late model answer preserves staff-reviewed destination/review and the current assessment pointer, whether null or this assessment.
- The shared transfer sequence uses one state: operator moves intake to Sales, loses queue access, is rejected when trying to draft, then the Sales operator records a correction back. It has three actual canonical calls and two assertion checkpoints.
- A valid owned attachment can enter a draft; a valid unrelated unattached upload rejects at actual attachment authorization. File setup is not mislabeled as operation failure.
- Failed or unknown send remains unknown; only valid accepted/not-sent provider results or a genuine dispatch skip establish those facts. Stale uncertainty cannot erase terminal evidence. Reconciliation updates only its matched attempt and preserves the original send receipt; no send occurs inside the handler.
- Current authorization, check/attempt limits and non-send proof govern explicit recovery. Closing unresolved queued/unknown work rejects.

Fixture limitations are deliberate: snapshots do not prove earlier calls ran; provider success receipts are isolated admitted data, not a live JEV/Ollama/mail result; protected recipe setup cannot fabricate provider certainty in production. Invalid normalization, unauthorized receipt observation, MIME/finalizer behavior, transport/concurrency/idempotency and crash recovery need the canonical runtime/adapter suites. The shared-state sequence and all BDD execution remain unimplemented. No visual renderer or deployed email flow was run.

The three JEV consultations in this directory informed only the judgment authoring and reviewed-visibility tradeoff. They are advice, not verification. The prior unrelated C3 rejected export was preserved and not retried. The accepted profile and provider facts are sourced in [the Inbox design](../../complex-apps/inbox.md).
