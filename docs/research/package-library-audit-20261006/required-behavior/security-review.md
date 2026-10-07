# Independent persisted-security review and reconciliation

Clean-room **Astra high** review at `16def5f95f51dbfb158d0ac086323ac256ee1c6d`: 20 finite rule groups, 10 findings. Root rechecked cited source and retained the scope limits. No runtime, race, deployed-state or infrastructure execution occurred. This is not full package security acceptance.

[Raw review](independent-security-review.json) retains exact authority stage, compatibility verdict, migration/rollback and uncertainty. [Reconciliation](security-reconciliation.json) links findings to the main classified records. [Anchor hashes](security-citations.tsv) are independently reproducible.

| Finding | Required action in a later selected packet | Source-evidence limit |
| --- | --- | --- |
| `F01` | Identity conditionals remain unfenced. Void consume followed by grant mint permits two pre-readers to proceed; recovery and last-owner guards span independent statements. | Preserve single-use/owner/revocation safety outcomes; proposed J2 mechanism and outcome names require separate acceptance. Static gap, no race execution. |
| `F02` | Accepted T32 live revocation direction and source narrowing conflict with unreconciled DESIGN already-admitted-may-finish wording; already-fenced-batch ordering remains open. | Reconcile scope in design; do not weaken live checks or claim full fence proof. |
| `F03` | CSV schema consent echo lacks review app/team/time binding and owning business review-per-row; render ID age does not establish 24h review TTL. | Treat full private-review flow as a gap, not normative authority for unsigned current fields. Canonical auth still applies; no deployed exploit claimed. |
| `F04` | CSV route rejects old operation IDs before invoking canonical receipt lookup, potentially rejecting retained successful receipts after 24h. | Adjudicate transport ordering against receipt-first semantics; tests of early rejection cannot justify contract inversion. |
| `F05` | Event file helper creates a new file on every valid call and has no occurrence/content replay check; shape validation is not verified-source authentication. | Conditional helper gap, no live caller found in inspected package source; require owner ingress/dedup join before claiming declared event contract. |
| `F06` | PublicationSession reviewed-byte guarantee is incomplete: verifyReviewed does not read disk or check missing reviewed entries, and publish does not require successful verification or recheck hashes. | Do not call preparatory helper an implemented deployed integrity guarantee; repair/qualify before selected native adoption. |
| `F07` | State hashes pre-validation inputs while DESIGN says normalized explicit inputs. Arbitrary serializer toJSON/exotic-object behavior is not justified by public export. | Trace actual historic transport/admission profiles before normalization change; retain original receipts/version evidence, never bulk rehash current objects. |
| `F08` | Compiled identity helper and native selection scaffold are not proof all production commands enforce them; compiled identity equality is not full artifact authenticity. | Keep caller/stage qualification explicit; public exports/tests do not establish deployed behavior. |
| `F09` | Nonzero Wrangler exit is reported as nothing applied, stronger than local subprocess evidence can establish. | Preserve honest uncertainty/partial state; do not turn this wording into required compatibility. No live apply checked. |
| `F10` | Staging plain-JSON-safe claim exceeds a no-throw stringify probe; nested undefined/nonfinite are not rejected or demonstrated lossless. Real producer normalization/domain is not established. | Concrete validation limitation; classify actual production defect/admission contract only after caller-domain and persistence comparison. Keep invocation replay hashing and effect payload normalization separate. No tests/runtime or redesign performed. |

## Disposition

- Preserve required authority/atomicity/identity outcomes and actual persisted/wire profiles, not every mechanism or exact error sentence. Proposed identity fence APIs remain proposed.
- Credential hashes cannot be bulk rederived from hash-only records. Receipt, consent and occurrence digests cannot be migrated by hashing newer mutable inputs. Unknown historical source evidence stays unknown.
- Keep CSV private-review lifecycle, fresh-row admission and completed receipt replay distinct. The early age gate raises a contract conflict; the audit does not authorize bypassing current authority/expiry checks.
- Publication helper checks and binary resolver presence are weaker than real joined integrity evidence. Native preparation remains held, with actual host/installed qualification required before adoption.
- The JSON probe permits normalization, but no actual admitted production data loss was demonstrated. Root and independent review both retain an unresolved domain/payload-preservation question.
- No new difficult design mechanism was selected. Later material decisions require balanced repository evidence, owner handoff and the JEV procedure; no new consultation was needed for this classification.
