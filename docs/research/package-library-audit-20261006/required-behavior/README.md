# Required behavior and compatibility authority

Step 3 of the package simplification audit, 2026-10-07. **Planning only.**
No product code, runtime policy, frozen profile, database, backend default or
implementation authorization changes in this checkpoint.

The [contract index](contracts.md) and [full records](contracts.jsonl) classify
**400 records across all 316 previously inventoried responsibilities and 13 packages**.
A behavior can span several responsibilities and one responsibility can contain
several independently changeable rules. These are classification records, not
400 new tasks or a claim to have proved every branch. The [crosswalk](responsibility-contracts.tsv)
records 301 duties with rules and 15 test/support duties with an explicit
no-additional-product-rule disposition. Public support APIs still require caller
and compatibility review before retirement.

## Classification and authority

| Primary class | Records | Meaning |
| --- | ---: | --- |
| Product requirement | 84 | An intended workflow or semantic outcome has affirmative design/user authority. Incomplete implementation cannot redefine it. |
| Public contract | 145 | A declared API, wire/interface or released finite profile needs explicit consumer/version consideration. An export does not make every implementation quirk normative. |
| Persisted protocol | 41 | Existing stored/wire identities, hashes, encodings or replay records need compatible reading or a deliberate transition. This is not evidence that data is deployed or that the format is optimal forever. |
| Deliberate security policy | 67 | Preserve an explicitly required authority, disclosure, atomicity, integrity or isolation outcome. Its particular mechanism can change. |
| Implementation accident | 2 | An affirmative source/receipt contradiction exists. Neither tests nor default behavior justify preserving it as a feature. |
| Unresolved assumption | 61 | Available evidence does not justify either permanent preservation or silent removal. Resolve the finite domain/caller/policy question before changing it. |

Secondary classes retain overlaps. Classification and authority stage are separate:
accepted design may be unimplemented; a selected port gate may be a temporary
parity constraint; a current public interface may be an opt-in prototype. The
records retain each source's declared stage and distinguish **authority** from
**observed evidence**. Source comments, tests, fixtures, JEV advice and existing
restrictions do not independently establish desired product policy. Narrow
accepted library/host receipts do not close their parent workflows.

This analysis uses frozen source `16def5f95f51dbfb158d0ac086323ac256ee1c6d`. The package tree remains equal to
that pin. Concurrent compiler documentation commits are preserved; compiler
caller evidence is interpreted at the recorded pin. [Source hashes](source-index.json)
and [citation anchors](authority-index.tsv) make the basis inspectable.

## What preservation actually requires

- Preserve exact language numeric outcomes, canonical operation ownership,
  current authority/disclosure and authored workflow semantics. Half-even
  rounding, result-only aggregate checks and canonical exact scalar wire values
  have design authority; they are separate from incidental JS evaluation traces.
- Treat token/password/email encodings, operation-input hashes, receipts,
  occurrence IDs, default attribution, queued handler contracts and reviewed
  artifact digests as explicit version/transition boundaries. A hash algorithm
  library can replace mechanics while preserving bytes; a new hash profile
  cannot be substituted silently.
- Keep frozen selected compatibility profiles at their proved scope until the
  owner selects a change. Exact prose, unusual source-map inputs, getter traces,
  alias/object identity and arbitrary host-object behavior are not automatically
  permanent requirements. The [open questions](unresolved.json) identify these
  separately from necessary product semantics.
- Retain fail-closed interim behavior while joining required capabilities.
  Deliberate `/auth`/query/test-loader placeholders are incomplete product joins,
  not accidental bugs and not final behavior promises. Native preparation HOLD,
  opt-in backend limits, default-TS policy and backend retirement gates remain.

## Material mismatches and open joins

| Boundary | Required outcome versus current evidence | Contract records |
| --- | --- | --- |
| CSV | Design requires schema-aware nullable/text/exact/ref/JSON mapping, configured row review, private app/team/user context and finite lifetime. The released grammar mechanism does not establish these joins. The current empty-cell omission/flat mapping and consent scope need explicit disposition. | `AD-csv-product-map`, `AD-csv-current-map`, `AD-csv-current-review`, `AD-csv-digest-wire`, `AD-csv-size-gap` |
| Identity | One-use completion, all-or-none recovery and last-owner safety need real atomic admission. Conditional SQL and memory doubles do not prove a winner or a multi-statement fence. The proposed J2 mechanism remains proposed. | `AD-identity-atomic-gap`, `AD-presession-origin-gap` |
| Replay | Accepted design wording, raw pre-fill digest, revocation timing and two outbox identity profiles must be reconciled with historical namespace/bytes and projection rules retained. | `SW-007`–`SW-014`, `SW-051`, `SW-063` |
| Numeric/JSON profiles | Native diagnostic truncation differs from the TS surrogate-cut profile; desirability of the exact diagnostic profile is separate. A no-throw JSON probe alone does not prove lossless payload admission. | `vv.native-astral-truncation`, `vv.number-diagnostics`, `SW-035` |
| Browser | Generated full-page render lacks its required shell input at this pin. Asset staging does not prove serving, bootstrap or full browser workflow acceptance. | `AD-ui-shell-missing-join`, `CF-C23`, `CF-C36` |
| Receipts/fanout | A real Node receipt fallback exists, but installed work binding and actual durable driver/authority/notification joins remain distinct. | `CF-C24`, `CF-C25`, `SW-072`–`SW-079` |
| Native/release | Framed protocol and helper integrity APIs do not establish default adoption, actual invoked binary admission or publication of exact reviewed bytes. | `CF-C20`, `CF-C29`–`CF-C34` |

These are source/audit findings and change gates, not new runtime test results,
exploit demonstrations or permission to implement. Original T08/T26, durable,
installed, application-journey and broader product acceptance remain separate.

## Migration and verification

[Migration requirements](migration-requirements.md) distinguish data/protocol
transitions from equivalent internal substitutions. A rule's migration assessment
is conditional on changing its affected boundary; it does **not** require a
database migration merely because a library replaces an algorithm.

Three focused Sol high analyses cover values/contracts/stdlib, state/work and
identity/interfaces/UI/services/files/testkit. Originating Codex consolidates and
reviews Cloudflare authority. The finite independent Astra high persisted-security
review covers 20 groups and records 10 source/design findings. The
[review and reconciliation](security-review.md) preserve the source limits. Review is
analysis, not production security acceptance. No new policy choice or JEV design
selection was made; materially unresolved choices remain for their own packets.

Reproduce structural/hash verification from the repository root:

```sh
python3 docs/research/package-library-audit-20261006/required-behavior/verify.py --repo .
```

The verifier checks all crosswalk IDs, categories, pinned sources and citation
anchors, artifact hashes and current package equality. Human semantic review is
recorded; line/hash checks alone cannot prove a citation's interpretation. It does
not build, execute, install or qualify product behavior.

Step 4 source recheck corrected `AD-export-csv-bytes`: the existing serializer uses LF record separators and a trailing LF (`export.ts:260`), not CRLF. The contract ID/classification and source checkpoint remain; this is a factual audit correction, with no runtime/profile change. The new exact observation anchor is `A1021`; source hashes and classification counts are unchanged.
