# Draft transition to change 2

Exact authored predecessor: `/Users/vince/Projects/canlang/design/evaluation/evidence/adoption/experiments/C/change-1/app.can`; SHA-256 `67b73f4fccf5a721425e92bac19f100306d8c2c65a67339774d53744a7bae0ee`. This identifies the prior experiment artifact, **not** a compiler-issued installed snapshot. No installation, actual records or migration history is asserted.

## Desired transition

- Add `Request.cost_centre:text? max=40`. Null is a context-free compatible initialization candidate, subject to full constraints, scope, history, pending interfaces and version analysis. Do not infer actual historical cost centres.
- Preserve `Request.note` through an explicit `Request.details` mapping. Preserve exact text, null and empty string, row identity, request owner/department, archive reason, archived status and audit evidence. No trim/default transformation applies to this field.
- Narrow `Request.title` to max120 without truncation or rewriting. Validate every retained row, including archived rows, before activation. Any value longer than120 blocks activation.

The exact existing notation for the rename is shown below. The header is deliberately an unbound template, outside executable `app.can`; the placeholder is invalid as an installed snapshot and activation must fail until pinned:

```can
migration EquipmentRequests from="REPLACE_WITH_VERIFIED_COMPILER_INSTALLED_SNAPSHOT"
 rename before.Request.note to Request.details
```

The narrower title constraint is in the desired schema; representation-preserving constraint validation can run without a mapper, and must fail on incompatible retained values. No invented length/count helper or mutating truncation backfill is supplied. No backfill is needed for the preserving rename. Null initialization for the added field must follow the frozen shared contract; name-only rename preserves versions, while actual null materialization may advance affected rows once with migration attribution.

## Activation evidence and remediation boundary

Obtain the compiler's exact installed owner snapshot and pinned language/runtime/resources, bind it to the verified old artifact/release, inventory the complete retained dataset and queued/interface/version bindings, and validate the desired state before activation. Explicitly correct overlong **open** titles using change-1's old max200 contract, ordinary ownership and stale-version checks; revalidate afterwards. Do not claim an invented population was found or corrected.

An overlong **archived** title also blocks activation. The old contract disallows editing archived rows, so “correct using the old contract” cannot resolve that case. No restoration or historical-title correction operation is documented. If that population exists, activation requires a separately authorized, specified disposition compatible with immutable archive evidence, or remains blocked. This draft neither drops those rows nor invents an archive-edit API.

Existing archives without reason would already block transition from the original initial source to change-1's evidence invariant. Their actual population is unknown. Do not fabricate historical reasons. A real deployment must settle this earlier transition with verified historical evidence and an explicit compatible transition before using change-1 as this predecessor.

Browser/MCP/forms/CSV bindings now use `details` and `cost_centre`; title inherits the max120 constraint. CSV stable header `note` no longer names a writable input, and requires explicit mapping to `details`. No wire alias or automatic mapping is invented. Inventory outstanding old inputs/receipts and client schemas before activation; source field mapping alone does not install interface compatibility.
