# Stored state machines

A stored scalar enum field may opt into a flat lifecycle machine. Its constant default is the initial state. Operations declare edges with `transition record.field source -> target`; each edge is owned by its declaring scenario or trusted handler. Ordinary `set`, CRUD patches, create inputs, and hook rewrites cannot assign the managed field.

```can
Given
 Job { status:enum(queued,running,ready,failed)=queued machine }
When
 # Start processing a queued job.
 scenario start(job:Job) by=members
  do
   transition job.status queued -> running
```

This is a fragment requiring membership, model policy, and a usable page or caller. A transition validates the operation-owned edge and current provisional source. Mismatch is a business-rule failure; malformed edge data is validation failure. A later failed guard/effect rolls back the transition. Fixture and migration snapshots may use any declared state without implying an edge was taken.

V1 is a flat stored lifecycle, not a general statechart: no hierarchy, parallel/history states, callbacks, or implicit cascades. State name alone does not protect delayed completions after leaving and reentering; use an explicit version or occurrence guard. See [scenario effects](02-scenarios-and-effects.md) and [transactions](03-transactions-and-concurrency.md).
