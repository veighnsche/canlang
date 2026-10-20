# Operating an app

Monitor the active app's health, pending work, failures and retention obligations, then use the owning workflow to recover safely.

## Check health and pending work

Verify the active release and environment, then inspect runtime health and bounded queues for delayed or failed work. Separate business state from delivery state: a queued message or provider receipt does not prove the business action completed. Review operation results and delivery receipts under their own identities.

For every failure, determine whether it occurred before commit, after commit, or at an external boundary with an uncertain outcome. A precommit refusal should leave business state unchanged. After a timeout, reconcile the stable operation/delivery identity before retrying to avoid duplicate effects.

## Recover within the owner

Use the supported retry, cancellation or reconciliation operation for that work type. Confirm current authorization and source/data revision before replay. Do not replay a stale scheduled action simply because its runner reported failure: the record may have changed and the eligibility guard must be evaluated again.

An operator's broad access does not imply permission to bypass app rules. Preserve audit history and report explicit outcomes. If the system cannot determine whether an external effect occurred, record the uncertainty and reconcile with the provider before issuing a new effect.

## Retention and change

Honor declared retention for records, files, logs and receipts. Archive, expire and permanently dispose through their distinct policies; removing a database reference does not guarantee that stored file bytes were disposed. Before a release upgrade, inspect pending work and follow [upgrades and recovery](./04-upgrades-and-recovery.md).
