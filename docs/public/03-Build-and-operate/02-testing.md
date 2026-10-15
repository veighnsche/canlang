# Examples and application testing

Write business expectations beside operations, then verify the same behavior through the interfaces people and agents actually use.

## Attach examples to behavior

Fixtures in `Given` name initial records. An `examples` table belongs to the operation it exercises. This complete app demonstrates a successful update, stale version and denied actor:

```can
# Track tasks and verify member updates.
app TaskExamples
Given
 Todo { title:text trim, done:bool=false }
 policy Todo read=members
 fixture task=Todo {title="Ship prototype"}
When
 crud Todo by=members fields=title,done
  examples update record=task
   as,changes.done,request.record.version -> record.done
   members,true,1 -> true
   members,true,0 -> error(conflict)
   public,true,1 -> error(forbidden)
Then
 page / title="Tasks"
  list Todo
   edit
```

The table names inputs to the left of `->` and expected observations to the right. Each row uses its own isolated fixture state. The stale-version row must fail rather than overwrite the record, and the public actor must fail authorization. Fixture values are test inputs, not production users or grants.

## Choose meaningful expectations

Cover an allowed actor, a denied actor, a bad business transition and relevant concurrency. Assert resulting state or typed output, not only that the call returned. Include role revocation, relationship boundaries, invariant failures and external failure recovery where the app requires them.

Independently authored expectations are valuable: copying implementation calculations into expected values can repeat the same mistake. Examples should explain the business contract to the next reader.

An isolated row does not prove a shared-state journey. For approval workflows, separately verify submit, reload, approve, rejection of a second approval and the original audit attribution.

## Run checked examples locally

First check source and emission:

```sh
can check TaskExamples.can
can compile --format=json TaskExamples.can
```

For an admitted local session on that source, use `can dev check`, read its revision, then run `can dev example.run --expected-revision rN` with the actual revision. Read executed, failed and unsupported counts. A zero-case or setup-failed result is not a passing business example.

The lower-level `can test --artifact PATH` consumes an actual emitted artifact and the application's installed runtime. The invoking app must provide both `@canlang/cloudflare` and `@canlang/testkit`; use the matching source workspace installation or prepared application package. Do not substitute a JSON diagnostic response for an artifact.

## Exercise browser and MCP journeys

Check that forms submit real canonical operations, errors remain understandable, data survives reload, and denied requests fail at the server. Test empty and populated states, long content, keyboard operation and small screens. Verify that a tool caller has the same business boundaries as a browser caller.

For generation acceptance, the app supplies its own Playwright config and browser dependencies. `can validate App.can` runs saved-output acceptance without generating new code. Missing configuration, skipped browser cases and failed checks must be resolved in their owning layer.

## Check the language workspace when contributing

These repository commands have distinct scopes:

```sh
bun run typecheck
bun run check:boundaries
bun run test
bun run test:compiler
```

`test` runs root integration suites after their producer builds. `test:all` also runs owning package and Cloudflare runtime suites sequentially. Choose the checks relevant to the change. A compiler test, a runtime example and an end-user browser journey establish different outcomes.
