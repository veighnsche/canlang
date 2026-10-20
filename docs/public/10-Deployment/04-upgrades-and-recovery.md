# Upgrades and recovery

Upgrade an installed application by reconciling its exact schema, pending work and new runtime before making the new release active.

An upgrade coordinates source compatibility, stored data, generated implementation, queued work and environment resources. Do not treat it as a compiler installation update. The installation process updates the local toolchain; this page concerns an app already serving users.

## Prepare a compatible transition

Identify the installed predecessor and any outstanding work created by it. Validate the new schema migration against complete stored data, and decide how old pending operations, schedules or deliveries remain valid, are cancelled, or are reconciled. Inventory work from older retained releases as well as the immediate predecessor. Preserve its identity and outcome history; cancellation alone does not prove an external operation stopped. An explicit `invalidate before.handler` can skip eligible inventoried, undispatched work from that pinned asynchronous handler contract; it cannot cancel in-flight, accepted or uncertain provider work.

Prepare the new release and migration in staging. Deployment closes affected admissions, writers, cleanup and dispatch and fences old runtimes before freezing predecessor data. If preparation fails, the installed data/release remains selected; retain the failure details and reopen access only when the owning recovery boundary permits it. Do not repair a staging failure by deleting user records or receipts.

## Activate and recover

Activation is gated by compatibility and serve readiness. If it refuses, use the reported reasons to correct the migration, binding or pending-work issue, then repeat validation from the current state. Recovery resumes or rolls back only at boundaries supported by the owning operation; a provider timeout can have an uncertain outcome and requires reconciliation before retry.

Activation across D1 and several Durable Object authorities is not one transaction. If activation partly succeeds, keep affected access closed and resume; do not reopen the old runtime against mixed layouts. No zero-downtime or automatic destructive rollback is promised.

Preparation failure and partial activation have different recovery boundaries: preserving the installed selection does not permit reopening an old runtime against partly converted authorities.

```mermaid
flowchart TD
  accTitle: Recover an application upgrade
  accDescr: Preparation failure retains the installed release and data. Valid preparation proceeds to gated activation; partial activation keeps affected access closed and resumes rather than reopening the old runtime against mixed layouts.
  close[Close affected access and fence old runtimes] --> prepare[Prepare and validate target state]
  prepare --> prepared{Preparation succeeds?}
  prepared -->|No| retain[Retain installed data and release]
  retain --> recover[Recover at the supported boundary]
  prepared -->|Yes| activate[Attempt gated activation]
  activate --> outcome{Activation outcome}
  outcome -->|Refused| correct[Correct reported reasons and revalidate]
  correct --> prepare
  outcome -->|Partial| resume[Keep affected access closed and resume]
  resume --> activate
  outcome -->|Complete| verify[Verify release and pending work]
```

After activation, verify the new release and inspect pending work. If a defect requires rollback, confirm that the previous runtime remains compatible with the data and work already accepted under the new release. A code rollback cannot undo committed business operations or external side effects.

The public workflow must keep this process at the app/environment level. Internal staging files and sidecar construction are implementation details, not authoring commands. See [operating an app](./05-operating-an-app.md) for the operator's status and recovery responsibilities.
