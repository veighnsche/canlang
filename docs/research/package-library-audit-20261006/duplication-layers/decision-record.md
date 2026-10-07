# Proposed duplication and layer dispositions

2026-10-07, source `4659b9477173e9ff423d2b4d8f1d1a19c8c2d007`.
Planning only; all candidate execution remains unauthorized.

**Proposal: consolidate exact private mechanics within their owning package.**
The candidate list identifies repeated serializers, SQLite mapping/query leaves,
UI projection/draft/error leaves, small admission projections, violation append
and civil-calendar helpers. Prefer the existing helper owner or a small private
dependency leaf, with callers retaining their current argument/result/error surface.
This should reduce independently maintained bodies without creating a configurable
cross-package framework. Actual maintenance and production-size reductions remain
unmeasured until a future qualified implementation removes the copies.

**Proposal: evaluate tiny forwarder/cache removals by actual caller benefit.**
Private numeric aliases and public facade frames provide modest navigation benefits
at most. A cache/parser abstraction that adds policy plumbing can outweigh its saved
lines. No new abstraction or interface is selected by this audit.

**Proposal: resolve test-support and prototype ownership explicitly.**
Move support implementations compatibly if useful, but distinguish module readability
from an emitted/archive closure reduction. The factory-lineage WeakSet is a deletion
candidate only after its existing assertion/future gate is retired; it is not a
demonstrated retained-memory leak. Prepared MCP and native preparation remain at
their declared unadopted/held stage rather than being deleted for lacking a local
production call.

**Retained boundaries for the current plan.**
Public contract/type assembly, transport versus semantic admission, transaction/fence
authority, persisted hash domains, sink-specific redaction, lossless UTF16 carriers
and deliberate TS/native donor/oracle coexistence remain distinct. Registered native
modules are not full installed adoption. No whole Work carrier conversion or automatic
TS backend retirement is selected. Preparation/native release remains HUMAN HOLD.

**Uncertainty and future acceptance.**
Actual external/deep-file consumers, exotic getter/proxy/iterator observations,
installed host/closure behavior, profile migration, retirement notices and performance
are not proved by static similarity. Consequential new semantic/security/ownership
choices require the repository's balanced JEV process and affected-owner handoff;
these conditional factual candidates do not resolve those choices.

This local proposal record is the handoff for a future accepted-decision update in
`docs/specification/DECISIONS.md`. That shared file is actively edited by the compiler
agent and is preserved here. No accepted semantic decision or implementation allocation
is made in this step. No merge occurs, so the living file-tree checkpoint is not advanced.
