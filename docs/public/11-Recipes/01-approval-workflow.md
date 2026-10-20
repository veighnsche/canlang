# Approval workflow

Model an expense submission as a guarded lifecycle with separate requester and reviewer authority, plus immutable supporting evidence.

This recipe is an application design guide, not a complete `.can` file. Define an expense record with its requester, amount/currency, status, submitted time and finalized attachment references. Keep the original evidence immutable; corrections should be new versions or explicit amendments so an approval remains tied to what the reviewer saw.

The requester drafts and submits. Submission verifies ownership, required fields and finalized files, then moves the record into the review state. A reviewer operation checks the current review role and state before approving or rejecting. Do not let the requester approve their own expense unless that policy is explicitly intended and reviewed.

Use an invariant to prevent invalid final states and a lock where a protected pre-state must remain stable across writes. A concurrent edit or duplicate approval should fail against the current version without partially changing the record. Denied users should learn neither the expense details nor whether a guessed identifier exists.

Store reviewer, decision and decision time as evidence. A notification is a separate delivery: record its status, but do not roll back an already committed approval just because email delivery is delayed. Test allowed and denied roles, incomplete submission, duplicate review, stale version and inaccessible attachment. See [forms](../06-Interfaces/03-forms-and-inputs.md), [files](../07-Integrations/03-files-and-attachments.md) and [transactions](../05-Workflows/03-transactions-and-concurrency.md).
