# CanSync preservation policy consultation

<a id="source-assessment"></a>

## Source: assessment.md

### Assessment

Three independent equivalent choices favored field-wise preservation: fields 0.96, 0.95, 0.57; whole projection 0.04, 0.05, 0.43. Reported confidence 0.91, 0.89, 0.13. The third wording leaves substantial uncertainty; no unanimous-certainty or empirical correctness claim.

Adopt a visible company-specific bounded rebase rule in CanSync, using the existing conditional provider write and explicit reviewer action. Do not bake field ownership/merge policy into a generic synchronization runtime. Preserve exact approved before/after values; retain unrelated remote edits; stop on overlapping changes, changed authority, unknown prior write, or three attempted writes. A converged read is evidence of observed state, never proof of original request causation or safe late-write cancellation.

<a id="source-wording"></a>

## Source: wording.md

### Wording/equivalence check

All three requests preserve the same three fields, preparer/reviewer separation, Account-only If-Match support, stale-read/lost-reply uncertainty, existing draft mechanisms, complete alternatives and both costs. Context, selection question and option prose are freshly worded; technical identities/option keys remain stable. No vote or approval threshold is defined. Provider evidence: https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-retrieve-patch.html . No secrets, account data or proprietary provider payloads are included. This is a new synchronization-policy decision, not a retry of the rejected history or dependency exports.
