# Operating an app

Inspect active releases, transition phases and pending work, distinguish operator authority from business permissions, and reconcile failures without duplicating external effects.

## Check health and pending work

Verify the active release and environment, then inspect runtime health and bounded queues for delayed or failed work. Separate business state from delivery state: a queued message or provider receipt does not prove the business action completed. Review operation results and delivery receipts under their own identities.

For every failure, determine whether it occurred before commit, after commit, or at an external boundary with an uncertain outcome. A precommit refusal should leave business state unchanged. After a timeout, reconcile the stable operation/delivery identity before retrying to avoid duplicate effects.

## Recover within the owner

Use the supported retry, cancellation or reconciliation operation for that work type. Confirm current authorization and source/data revision before replay. Do not replay a stale scheduled action simply because its runner reported failure: the record may have changed and the eligibility guard must be evaluated again.

An operator's broad access does not imply permission to bypass app rules. Preserve audit history and report explicit outcomes. If the system cannot determine whether an external effect occurred, record the uncertainty and reconcile with the provider before issuing a new effect.

## Retention and change

Honor declared retention for records, files, logs and receipts. Archive, expire and permanently dispose through their distinct policies; removing a database reference does not guarantee that stored file bytes were disposed. Before a release upgrade, inspect pending work and follow [upgrades and recovery](04-upgrades-and-recovery.md).

## Inspect the release before acting

Use the target's deployment/operator surface for release administration and the application's canonical operations for business recovery. Browser admin roles, provider account access and deployment authority are separate grants.

For each incident, obtain the selected app/environment, active artifact, installed owner snapshots, transition phase, admission/fence status and outstanding-work summary. Then narrow to the failing operation or delivery identity. Inspect bounded, authorized details rather than dumping private business records into logs.

The public CLI supplies `can deploy --preview` for planning, `can deploy --yes` for authorized apply and `can activate` for the serve-gate verdict. It does not imply commands named `can deploy rollback`, `can migration resume` or a generic administrator bypass. Use the selected target's supported operational controls for those lifecycle responsibilities.

## Work an uncertain-delivery incident

Suppose a member sees a pending payment or message after a provider timeout. Locate its retained delivery association and request identity through the app's authorized view. Determine whether the provider accepted it using the app's reconciliation operation. A new delivery is not a diagnostic probe: it could create a second charge or message. If permission was revoked, do not broaden the user's access merely to display the result; let an authorized operator inspect the permitted outcome.

After an upgrade, include older retained releases in the work inventory. A handler with the same name can have a different contract. Work that cannot be matched to its actual retained contract blocks the transition rather than being assigned a guessed disposition.
