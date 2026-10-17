# SEM-R04 email admission — frozen policy, implementation qualification pending

## Selected shared obligation

Root selects the existing public values codec's conservative shape floor as the language admission obligation for Unicode scalar strings. Require exactly one U+0040 `@`, with at least one scalar before and after it. Reject exactly these scalars anywhere in the value:

```
U+0000..U+0020, U+007F, U+00A0, U+1680,
U+2000..U+200A, U+2028, U+2029, U+202F,
U+205F, U+3000, U+FEFF
```

Preserve all accepted authored text. No trim, Unicode normalization, case folding, IDNA conversion, dotted-domain condition, label/TLD/local-part grammar, DNS query, provider lookup or deliverability inference follows from shape admission. Email ownership/verification remains auth's responsibility. This contract concerns the same finite scalar-string inputs at checking, public decode and public encode; JS lone-surrogate strings are outside this scalar-string comparison.

The explicit set expresses current ECMAScript `\s` plus C0/DEL behavior. Neither Rust `char::is_whitespace` nor `char::is_control` is equivalent: the former uses Unicode White_Space, while the latter adds C1 controls. Examples deliberately distinguishing those properties include U+0085 (admit), U+FEFF (reject), U+200B (admit) and U+00A0 (reject). The primary normative references and findings are saved in `primary-sources.json`.

## Owning APIs and observed consumer

`packages/values/src/index.ts` exports `wire.ts`; both public codec functions call their non-dispatching `internal/wire-core.ts` core, where both email directions use the same `isEmailFloor`. The current installed dist follows this exact route. Stdlib directly re-exports those functions. Prepared codec paths delegate to the same TS core; their preparation lifecycle is not public email admission. The private Rust semantic transport's `ScalarName` recognizes int/decimal/money/date/datetime/duration, with no email codec. Its numeric/scalar naming does not make it this policy's owner.

Compiler `analysis/types.rs::validated_shape(Scalar::Email, ...)` calls `valid_email`. Its extra ASCII domain conditions are compiler-owned reconstruction. Removing them after the policy gate would repair both false rejection and false admission without changing public package APIs.

The source-pinned parent-built current CLI was copied before inspection (SHA256 `3db5e325da1be31b40a9ba108cafe51afff78b8870a99c15177889d1131d123a`). `probe.mjs` executed actual `check` and production `compile --format=json` with the real values catalog for all 113 independent cases. All checks are syntax-qualified, complete, omit nothing, and reject only with email E3001. Both public directions meet all 226 expected outcomes: 29 accepted exact strings and 84 rejected inputs. Compiler admits 34, differing on 14 owner-admitted domain cases and 19 forbidden Unicode scalars in the local part. All 34 emitted modules were imported and their retained exact default metadata was consumed by the installed public values codecs, producing the independently expected codec outcomes. Therefore emitting a default does not certify email admission: 19 metadata strings fail both public codec directions. This is metadata consumption, not full application invocation, auth, network or deliverability testing.

## Equal alternatives and reason for this proposal

1. **Current public floor:** pin the exact scalar rejection set above and one interior `@`, then align compiler only. Preserves current callers, local/Unicode address authoring and actual public conformance with a small owning-function repair. Its permissive unconventional domain/local forms are an explicit shape floor, not a deliverability guarantee.
2. **Unicode property floor:** keep interior `@`, reject Unicode White_Space and all C0/C1 controls across compiler and public codecs. Names Unicode properties consistently with text trim and excludes U+0085/C1. It changes existing acceptance and would admit FEFF unless a separate exclusion is chosen. Requires released package ownership and caller migration/qualification.
3. **Dotted ASCII domain floor:** use existing compiler domain conditions plus the exact public whitespace/control set across all three boundaries. Filters conventional ASCII domain shapes and keeps simple label checks. It rejects existing single-label/Unicode and unconventional domain callers while still not validating local syntax, DNS or delivery. Requires released package ownership and caller migration/qualification.

All alternatives are assessed against same-input agreement, authored-text preservation, adoption, focused implementation/migration, and separation of value shape from verification. No existing implementation alone settles the policy. Current DESIGN leaves the exact floor unspecified; existing public conformance intentionally admits `a@b`, and the smallest justified shared obligation is the current public floor.

## Advice and resolved consultation gate

Three independently worded equivalent requests now returned `jev-1.13.0`. Each selects `current_public_floor`; reported confidences are 1.0, 1.0 and 0.98, with selected probabilities 1.0, 1.0 and 0.99. Responses contain no explanatory rationale. Agreement is advice only; the owning API inspection, finite same-input comparison and balanced alternatives above support root's policy choice.

Original sandbox connection failures and automatic-review rejections of request 1 and 3 remain preserved. The human explicitly answered “Approve both payloads” to the saved-payload/destination disclosure question. Root sent exactly those two saved JSON requests, without extra context; both succeeded. `user-approval-receipt.json` pins the approved requests and raw responses. No transmission remains blocked.

Root freezes the current public floor and releases the focused leaf repair below. Implementation and independent post-change qualification are separate from this policy selection; the baseline receipts remain historical observations, with no replacement or recredit as final-source proof.

## Minimal leaf lease after freeze

- **Production writer:** only the contiguous `valid_email` doc comment/function in `compiler/src/analysis/types.rs`. Replace byte-only rejection with `chars()` and an explicit `matches!` scalar-range predicate, retain the existing split/empty/multiplicity diagnostics, and remove dotted-domain/label/TLD conditions. No new public helper/API, dependency, shared type, catalog or IR/JS change.
- **Acceptance writer:** new `compiler/tests/email_admission.rs` using the saved finite vectors and actual public package imports. Avoid editing the existing URL admission test or another active owner's file. Require all 113 clean/rejected CLI outcomes to match the two public directions and all 29 accepted emissions to retain the exact default through generated metadata-module imports and actual public codec consumption. Reject cases must report E3001 at the literal and emit no artifact. Record skip/precondition behavior explicitly, and ensure this environment does execute the consumer witness.
- **Documentation owner:** root records accepted policy/rationale/uncertainty in `docs/specification/DECISIONS.md` and updates compiler-completion evidence after the gate. No lease to package source/dist/bindings; foreign package owners remain untouched. No merge occurred, so no living-plan checkpoint advance is authorized by this evidence work.
- **Scheduling:** selected-call worker holds future `types.rs`/IR/JS ownership. Serialize this validator hunk through that owner, or root releases this exact frozen leaf to a low-reasoning implementation worker after the policy freeze. This research task has no delegated implementation authority.

The finite corpus retains exact source strings, scalar lists, expected classifications, raw check/compile outputs, emitted module bytes and source hashes. Current before/after owner input pins are unchanged. Appropriate post-change checks are the email integration witness and focused scalar checker suite; no additional broad re-audit or full suite is proposed here.
