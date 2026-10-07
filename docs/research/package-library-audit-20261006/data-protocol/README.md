# Data and protocol correctness audit

Planning-only source checkpoint: `f3dd798c866916b526b72e0a53c1ddf257748587`.
Implementation remains deferred. This step adds no product code or acceptance credit.

The [32-record witness ledger](witnesses.jsonl) examines representation and identity at
actual producer/consumer seams. Nine identity/CSV/privacy records describe gaps against
existing required outcomes; two additional records describe exported parser key loss.
Their caller stages differ: a source handler or supported adapter is not evidence of an
installed, mounted or exercised production deployment. The other records distinguish
private/native joins, declared profile limits, compatibility controls and held prototypes.
They must not be counted as 32 newly demonstrated production defects.

## Findings that should drive the next selected repairs

| Records | Concrete disagreement | Required outcome and limit |
| --- | --- | --- |
| IP04 | Review `qty\n1\n2\n`, select index 1; commit `qty\nbad\n1\n2\n`. Both consent digests contain the same valid candidate list. The selected index now invokes qty 1 instead of qty 2. | Bind frozen row identity/index/status and exact input to consent. Fresh operation ID and a conditionally mounted CSV handler are prerequisites; an existing conflicting receipt protects its own identity. This is a frozen-selection gap, not an authorization bypass. |
| IP06 | The same user can present unchanged consent after changing team/login or after 24 hours, with new operation IDs. | Review owner/context and expiry must be explicit. Current mutation authorization still applies. The private/integrity mechanism and transition from unsigned consent remain decisions. |
| IP08 | A provider rejection containing `bearer abc123` or `Account email alice@example.invalid` passes the blacklist unchanged into a completion message. | Project adapter-owned safe explanations; untrusted free text is not made safe by a pattern blacklist. Supported email/model/media source paths are traced; installed provider bindings and traffic are not proved. ComfyUI's adjacent path is result `detail`, not `DeliveryError.message`. |
| IP01–03 | CSV blanks become absence regardless of type; blank unknown columns disappear; `-0` and `0` integer rows compare differently although the owner decodes both as 0n. | Type-directed presence, header/mapping admission and owning codec normalization must precede candidate identity. Do not rehash old mutation receipts or invent decimal equality policy. |
| IP05 | Server commit accepts reversed row selections and executes in caller-array order. | Enforce declared source-row order. The current UI already sorts indexes; the witness uses an admitted direct JSON caller. |
| IP07 | HTTP/CSV rejects an old operation ID before the canonical owner can return a matching retained receipt. | Transport checks shape; canonical receipt lookup precedes age enforcement for unseen identities. Keep current replay projection and authority checks. |
| IP09 | Authorize accepts a 44-character S256 challenge; every exchange computes a 43-character encoding of 32 hash bytes. | Match challenge admission to the actual S256 output domain before issuing a code. Verifier syntax and persisted-input tightening are separate compatibility decisions. |
| DP01–02 | Form `__proto__=x` loses its own key, whereas JSON retains it. Exported query helper also turns `filter[__proto__]=x` into present-but-empty filters. | Use an existing safe own-key construction primitive or explicitly refuse the key before conversion. Query production caller was not found. Top-level operation extras are deliberately lenient; no authorization or reachable prototype-object injection is established. |

Each row has exact inputs, source anchors, contract authority, counterevidence, caller
stage and required negative controls in its family packet. All package disagreement
witnesses are **source-derived and unexecuted**.

## Native and private gaps remain separate

| Records | Witness or constraint | Gate before a broader claim |
| --- | --- | --- |
| PV01 | A genuine owned token's exposed value and buffer can be changed while its original text remains unchanged. | Issuance provenance is not content immutability. Keep authoritative mutable storage private or explicitly narrow its authority. No connected production native request is established. |
| PV03 | A valid normalized Decimal default reaches the private prepared copier, which rejects its nonplain prototype. | Requires explicit private provenance first. Admit only validated scalar carriers or retain explicit abstention; public TS validation is unchanged. |
| PV04 | A raw duplicate `minor` tuple is read first-wins by native decode and last-wins after host reconstruction. | Existing transport hygiene requires unique keys, but raw decode does not enforce it. Normal host tagging emits unique entries; the six-operation profile does not include this codec. |
| PV05–06 | UTF-16 diagnostic truncation can retain a lone high surrogate in TS; Rust backs the cut down. A lone-surrogate input is admitted by JS JSON but refused before native codec execution. | Preserve explicit exclusions. A broad error/Unicode claim requires an owner-approved lossless carrier or changed contract, not replacement-character normalization. |
| PV08 | Correct native violation fields are discarded by `wasmBackend` into a generic ValueError. | Qualify the complete owning public projection before selecting native codecs. Raw native payload tests and the six-operation host profile are different gates. |
| PV02, PV07 | `input.digest` echoes root shape/text and collides for changed children; opaque JSON preserves authored order rather than universal canonical bytes. | Echo is explicitly not a content hash. Choose identity/disclosure only for a real consumer; canonical shape, byte identity and value equality are distinct. |

Current matching `f587…` Wasm and Step9/12 finite qualification credit is retained.
It proves neither broad codec/validation adoption nor automatic default selection.
Decimal scale `-0` refusal is an intentional profile boundary (PVC01). TS/native plan
retirement capacity differs, but those halves have no joined current public protocol
(PVC02); choose the lifecycle bound at that real join.

## Compatibility constraints, not candidates for a generic adapter

* **PDW-01:** live Work counts use represented f64; JSON persistence normalizes `-0`
  and already rounds unsafe numeric input bytes. Exact integer wire codecs use strings
  and BigInt. Tightening legacy count admission needs its own migration.
* **PDW-02:** Work's safety-before-clone rejects repeated aliases as cyclic; State's
  clone helper preserves aliases and cycles. A later JSON durable sink still rejects
  cycles. This does not prove persisted-cycle support or a common clone contract.
* **PDW-03:** completion consistency accepts succeeded NaN, but receipt production
  rejects own undefined/nonfinite before copying. Omitted result is an arbitrary-JS
  helper witness; the TypeScript row interface requires that member.
* **PDW-04–06:** recovery duplicate claims are ordered last-wins; empty cursor differs
  from absence/null; callback demand/throw order precedes output sorting. Native
  closed facts do not authorize eager host reads or remove act-time fences.
* **PDW-11–12:** digest v1 JSON UTF-16 identity and v2 published UTF-8 byte identity
  differ deliberately. Map own-undefined suppresses a fallback that absence permits.
  Retain digest versions, exact submitted bytes and map presence.

Other positive controls: HTTP/owned parsers both use default nonfatal UTF-8 decoding;
integer/ref codecs retain exact string/range guards; collection limits use safe-integer
checks; ordinary JSON duplicate last-wins is separate from raw tuple hygiene;
manual sorted-key serialization is separate from reassembling a JS object; generic
public exception projection discards caught private details. No blanket precision,
UTF-8 refusal or privacy guarantee follows from these narrow controls.

## Held and conditional work

**IP10:** a supported JS media configuration can hash an own undefined extension as
null, then drop it during JSON cloning before submission. JSON-only producers cannot
supply this witness. Upload argument cloning has a related same-input retry conflict
for own undefined. Choose and enforce the owning host domain before deleting conversion.

**PDW-07–10:** held preparation accepts foreign redundant numeric bits/spelling that
disagree; foreign duplicate keys disagree between lookup and JSON rendering; its
framing cap occurs after some TS allocations; PublicationSession compares retained
metadata rather than the actual bytes it later publishes. These are bounded gates,
not current CLI incidents. The publication gap was already recorded as blocked P07.1.
Bare integer module-key ordering disagreement lies outside actual prefixed deployment
keys. Normal host encoders produce coherent numbers and unique keys. Releasing the
human-held preparation scope remains a prerequisite.

## Fix order and simplification

The [11-unit proposed queue](fix-queue.json) retains original task/contract crosswalks
and separates independently ready outcomes. First address safe projection, frozen
consent/lifecycle, typed mapping and S256 admission; then qualify ordering/replay at
the owning joins. Values/prepared and Work gates can proceed on their separate
dependency chains when selected. Held preparation remains held.

Remove conversions only after ownership and admitted data are established:

1. Replace unsafe plain-object assignment with an existing safe own-key primitive.
2. Reuse owning typed decode/encode for CSV identity, rather than another normalizer.
3. Remove media/upload JSON clone round trips only after a data-domain and isolation
   gate preserves the exact hashed/submitted/retried value.
4. Cache genuine frozen schema admission instead of reparsing/traversing it, only
   after private lineage/scalar copying joins are qualified.
5. Bound structural/framing ingress before duplicate materialization and allocations.
6. Publish the same reviewed byte snapshot rather than rereading mutable staging.

Do not consolidate serializers, clones, hash domains, error envelopes or callback
facts merely because their names look similar. Those shortcuts can increase adapters
and maintenance while changing behavior. No library addition, semantic migration,
backend retirement or accepted design decision is selected here.

## Evidence and reproducibility

* [Coverage](coverage.tsv): every requested dimension and the relevant limit/control.
* [Family packets](values.json), [identity/privacy](identity-privacy.json),
  [work/delivery](work-delivery.json), [root witnesses](root-witnesses.json): detailed
  inputs and source-derived outcomes. Normalized ledger scope corrections and
  independent reviews take precedence over broad wording in original packets.
* [Independent challenges](reviews.json): Sol high source reviews with prior
  conclusions visible; not cleanroom and not runtime acceptance.
* [Sources](sources.json), [scope](scope.json), [verification](verification.json):
  exact pin/current hashes, anchor checks and explicit execution limits.
* `python3 verify.py`: source/metadata checks plus eight standalone ECMAScript
  primitive facts from [reference-witnesses.mjs](reference-witnesses.mjs).
  That script imports only `node:assert/strict`, executes no Can package, and is
  **not** an end-to-end consumer, product test or acceptance receipt.

Concurrent compiler work and shared decision records remain untouched. The proposed
decisions stay [local](proposed-decisions.md) until an owning contract mechanism is
actually selected. Canonical task statuses, execution authorization, runtime topology
and living filetree checkpoint remain unchanged.
