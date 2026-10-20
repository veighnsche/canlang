# Review external account changes before applying them

Stage versioned external account names as immutable proposals, detect intervening local edits, apply only reviewed changes and distinguish transport recovery from business synchronization.

## Source and prerequisites

Download [ExternalSync.can](../examples/recipes/ExternalSync.can), a complete app for the inbound review/apply portion of synchronization. The provider contract for this example uses a stable external account ID and monotonically increasing integer revision for that account. If your source uses opaque revisions, adapt the comparison to its real contract rather than comparing strings as integers.

```sh
can check ExternalSync.can
can dev ui --source ExternalSync.can --preview-roles '{"Ava":["reviewer"],"Ben":["synchronizer"]}'
```

The `synchronizer` submits observed facts; the `reviewer` creates local links, edits names and applies proposals. The app exposes account names to team members, while only these two roles read proposal details. No background connector is implied. Use manual synthetic inputs first; a real connector must invoke the same canonical `propose` operation with authorized identity.

For durable external fetching, the complete two-file [account lookup walkthrough](../08-Connect-services/01-contracts-and-service-bindings.md) supplies a declared capability, send, completion and reconciliation. Its observations are not automatically a versioned source feed; your adapter must supply the source revision contract required here.

## Stage and apply one source revision

As Ava, create Account `external_id="demo-001"`, name “Old demo name”. As Ben, submit **Propose** for that account with revision `1` and name “New demo name”. The proposal freezes the local edit generation at intake and is unique by account/source revision.

As Ava, compare the proposal and account, then **Apply**. This excerpt is the complete application decision:

```can
scenario apply(proposal:Proposal) by=reviewer
 require not proposal.applied and proposal.source_revision>proposal.account.source_revision
 require proposal.base_local_revision==proposal.account.local_revision
 do
  set proposal.account {name=proposal.name,source_revision=proposal.source_revision}
  set proposal {applied=true}
```

The accepted source revision advances with the name in the same transaction. This operation does not write back upstream. Repeating a pending proposal with the same revision/name returns that existing proposal; different content at that revision is refused. A fresh call for an already-applied revision is refused as stale, while replay of its original logical request follows ordinary receipt rules.

## Detect a local edit before applying

Stage revision `2`. Before applying it, use **Edit** to make a deliberate local name change. This increments `local_revision`; applying the old proposal now fails. It cannot silently overwrite the local decision.

The sample deliberately has no force-apply or automatic merge. Keep the conflicting proposal for review. Resolve through an explicitly authored reconciliation operation or obtain a genuinely newer upstream revision after agreeing the change; never fabricate a revision to bypass the conflict. Adding a resolution action requires its own current-state guards and recorded decision.

## Verify source and transport failures

Try blank names, out-of-order revisions, duplicate revisions with changed content, repeated application, a revoked reviewer and two competing apply requests. Typed validation, uniqueness, source-order and local-generation guards must prevent unreviewed updates. The external identity is locked after account creation.

This source accepts only account-name updates. Deleted upstream records require an explicit tombstone/archive policy; absence from one response does not delete local data. A partially fetched provider page must not be treated as a complete account list.

If fetching times out, reconcile the original fetch association before requesting another external effect. A successful fetch does not prove `apply` committed. If the apply response is lost, retry its operation identity with unchanged inputs before issuing a new logical update. See [external connections](../08-Connect-services/06-external-data-and-app-connections.md).
