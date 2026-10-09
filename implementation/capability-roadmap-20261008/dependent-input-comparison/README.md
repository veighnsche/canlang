# SEQ-007 dependent-input comparison

The full source shells now use the implemented operation-owned `choices` metadata. The approval `submit` and `assign` assignee inputs bind to their existing `reviewer_choices` reads and project `Employee.user`, with the existing name, role, and home labels. The supplementary `save` operation binds Country choices to `country_choices()` and Region choices to `region_choices(country=country)`; the record-valued Region choice retains the complete typed Region reference. Both shells keep their canonical operations, server guards, and source workflows. The approval pages omit only the redundant candidate-bound control subtrees; the CountryRegion page uses one full save form in place of its three staged selector forms.

These bindings express the existing comparison using accepted metadata syntax; they do not provide partial sibling-draft listeners, cancellation/context fencing, or a custom invocation backend. They do not bypass canonical submission or current server authority. The fixtures' guards remain decisive, including approval eligibility and the Country/Region relationship. The original CountryRegion grants and model rules are preserved; the Country read remains scoped by `allowed`, while the Region read remains scoped by its parent Country's `allowed` grant. An empty approval candidate list does not narrow original role-only operator-wide admission.

SEQ-037 remains incomplete. Its finite actor-role/direct-parent browser/HTTP/MCP component is implemented and tested, but the complete two-witness qualification still depends on checked model-rule and conditional row-grant producers for the original CanApprove and CountryRegion sources. The current `readSelectorFacts`/`transcribeReadFacts` path supports actor-role facts; source `where` grants that require ruled model values are refused. Compiler/Contracts own release of the exact checked row-grant producer. Source navigation and authoring comparison, conditional grant behavior, compile qualification of these complete shells, and full UI qualification remain open. This packet claims no runtime benefit, adoption result, or token savings.

The 30 expected vectors and nine raw mutation vectors remain the historical finite comparison inventory, not evidence that all browser lifecycle behavior is implemented. They cover current membership/grants/revocation, current references/revisions, stale parent, cancellation/out-of-order/context, errors/empty/retained selection, cross-scope, simultaneous forms, keyboard/focus/localization, and final eligibility. Candidate selection is advisory; actual current role, distinct assignee, workplace scope, Country/Region relation, replay handling, and complete canonical submission remain server responsibilities. Independent acceptance of the complete original witnesses and the value decision remain separate gates.

## Historical observations

The following figures and diagnostics record the earlier SEQ-008/F1 preparation run; they are not current source measurements or qualification of the implemented bindings:

| Historical complete source | UTF-8 bytes | Whitespace-segment proxy |
| --- | ---: | ---: |
| Original CanApprove | 32,502 | 1,791 |
| Approval proposed source shell | 32,305 | 1,794 |
| CountryRegion current nested | 3,781 | 324 |
| CountryRegion custom composition shell | 3,652 | 324 |
| CountryRegion proposed source shell | 3,651 | 323 |

The historical semantic JSON sketch added 4,677 bytes across three bindings and shared rules. These are raw byte/whitespace figures, not actual token counts. The earlier selected compiler run reported five diagnostics for both full approval variants. Supplementary sources passed checking, while compilation reported query-order/pagination lowering gaps: five in the nested source and three in each single-form shell. The proposed JSON was not consumed in that run. The preserved CanRent diagnostic run linked only selected shared files, reported unresolved additional imports, and emitted 521 diagnostics; those were not full-closure feature findings.

The original full sources and prior inventories remain available alongside the comparison shells. `expected-vectors.json`, `current-runtime-gates.json`, and `measurements.json` retain their original finite inputs and historical scope; none replaces the current defining producer gates described above.

## Local continuation, 2026-10-09

The saved transport correction now passes the original native D1/happyDOM/installed Chrome/MCP workflow (1/1, 33.75s) after the owning runtime dependency build (22/22). The hold is captured before the real worker yields; teardown releases delayed responses, drains actual requests and preserves the first failure before closing ports. Existing cancellation, stale response, final guard, canonical nonce, revocation and reopen assertions are retained.

The complete approval shell's preference declaration now occupies `Then`, verbatim as in pinned draft `5a12eb9e`. With all three shared providers, its check reports the same four original diagnostics: two unsupported `parent.location`/`parent.category` table selectors and two inherited Employee `active_member` purity errors. The complete CountryRegion binding shell checks cleanly but compilation still refuses four original presentation profiles (breadcrumbs, two edit bodies and authored table rows). These are exact defining compiler/UI prerequisites, alongside the existing conditional-grant/model-rule gates; no source or permission reduction is used to obtain an artifact. Neither complete witness is execution-qualified.
