# Focused compatibility review

Sol high independently challenged four consequential seams against pinned
source and exact dependency APIs. This is a review of the fit assessments,
not a clean-room security audit or runtime acceptance. The earlier Astra
persisted-security findings F03/F04/F07 remain inputs rather than repeated work.

| Finding | Evidence | Reconciliation |
| --- | --- | --- |
| `FIT-C01` | Current source-map lookup picks the last equal-column mapping; trace-mapping GLB picks the first. Remapping uses the same child lookup. A static sorted/nonnegative duplicate-column example demonstrates the source-level distinction; it was not executed. | Full-map APIs remain conditional even on ordinary sorted maps. A small tie/coalescing policy bridge can be materially smaller than the present compatibility algorithms. No tie-profile change selected. |
| `FIT-C02` | The existing CSV export joins records with LF and appends LF at `export.ts:260`. The finite C04 handoff retained that serializer. | Corrected the inherited `AD-export-csv-bytes` CRLF description, adding exact source anchor `A1021`. Same-byte stringify evaluation uses LF, `eof:true`, explicit CR/LF/comma/quote quoting and existing formula armor. No output change selected. |
| `FIT-C03` | TraceMap copies caller-owned unsorted decoded lines before sorting, derives resolved sources and caches mappings; already sorted references may be shared. | Removed the broad input-mutation assertion. Cross-call mutation/cache lifetime and raw identity still need finite qualification. |

The numeric assessment correctly distinguishes String zero/nonfinite formatting
from JSON's null channel. Canonical JSON retains its admission/hash-profile gate;
a package that sorts keys cannot resolve normalization or historical identities.
CSV parser fit does not supply private consent, owning per-row business review or
receipt-first replay. No library was credited with these joins.

[Raw finite review](independent-review.json) retains source anchors, an
unexecuted map witness and limits. [Reconciliation](review-reconciliation.json)
records all three corrections. The assessments include the corrections; the
earlier report hashes identify the reviewed inputs. No product code, candidate
installation, build/test, policy selection or JEV design round occurred.

Future choices to narrow supported map domains, change equal-column behavior,
normalize persisted hashes or alter private CSV authority require their own
owner/consumer review and repository JEV procedure. Correcting a factual audit
description is separate from selecting those changes.
