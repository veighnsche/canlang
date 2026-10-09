# Bounded model query order

The production compiler now lowers a direct checked current-model alias field
and its unary descending form to the existing `IrOrder` representation and
native `records` order strings. The genuine owning source is
[`typed-authorized-reads.can`](../../../packages/cloudflare/test/fixtures/typed-authorized-reads.can):
`ascending` orders `entry.count`, while `descending` orders `-entry.count`.
Both project the same native integer field. Before the repair, compiling that
actual fixture produced two E6008 expression-query-order diagnostics and no
modules.

The minimal `compiler/src/codegen/ir.rs` change recognizes only the current
checked model alias's direct stored field, optionally prefixed with unary `-`.
The field must belong to that model and satisfy the existing Cloudflare native
scalar-order contract; no arbitrary key expression is evaluated. Existing
`IrOrder` and emitter strings are reused, with no new facade or carrier. This
case qualifies integer field ordering only.

The single production case
`compiler/tests/query_order.rs::production_model_query_order_preserves_direct_alias_fields_and_refuses_expressions`
passed **1/1 (0.40s)** using the real CLI and installed Values catalog. It reads
the unchanged genuine Work source, verifies the authored callables and exact
`records(c,"TypedAuthorizedReads.Entry",{order:["count"]})` / `["-count"]`
emission. Same-source arithmetic `entry.count+1` and a correctly typed foreign
root `entryRecord:Entry` / `entryRecord.count` each refuse exact E6008
`cannot lower expression query order: no §13 lowering exists`, without modules.
No unchanged test matrix repeated.

The same owning authorized D1 case now passes **1/1 (4213.82ms; 4396.74ms
total)** after production CLI exit0 and Cloudflare emit exit0. Owners and
auditors receive exact string-wire integers
`["1","7","14","9007199254740993"]` ascending and the reverse descending.
Members and anonymous viewers preserve existing ungranted-order validation;
the earlier proposed empty-array observer was corrected to that owning
contract. Earlier predicate/privacy, provisional-read, rollback and role-loss
checks are reused within the same changed native case.

That affected native case first exposed a real sorting defect: `14` preceded
`7` because mutation reads omitted model type metadata needed by State's
existing comparator. Work's minimal `invoke.ts` argument repair supplies
`models: loaded.models`; no State API, comparator or source change was needed.
Only the same affected native case repeated after the repair and observer
correction. The compiler **1/1 (0.40s)** result remains reused without rerun.

This qualifies and repairs the finite direct integer-field order slice through
the same genuine source, regenerated artifact and native authorized D1
consumer. Metadata ordering, computed keys and full S9-Q02/Q08 remain open.
Completion remains 58/67 with 9 open references. Work owns Cloudflare source
and genuine fixture/native consumer capture; coordinator owns
DECISIONS/coverage/index joins.
