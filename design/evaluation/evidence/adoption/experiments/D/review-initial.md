# Independent initial Django review

Root, 2026-10-04. Static review of `initial/equipment/{models,forms,service,views,chat_auth,mcp_server,tests}.py`, wiring/assumptions and UI bindings. Same eight first-app outcomes as C; no source edits or regeneration. Syntax checks from the subject are not executed acceptance.

| Required outcome | Inspectable evidence | Result |
| --- | --- | --- |
| Create | `principal` reloads active membership; `mutate(create)` derives owner and department; `validated` permits only title/note/private and uses ModelForm | Expressed, constraints and tests present |
| Own update | Current member and row locks, owned-row query, positive expected version equality, open-state check | Expressed; PostgreSQL concurrency assumptions explicitly disclosed, not verified |
| Other employee denial | `scoped` limits owners/current managers, mutation queries owner only | Expressed; no finance/superuser bypass added |
| Manager scope | `scoped` uses department manager membership and private flag, reads through `listing` | Expressed under its disclosed private-checkbox interpretation; see comparability limit below |
| Invalid title | Model max160 and ModelForm required/trim semantics reused by service, browser and MCP | Expressed; Python parsing does not establish actual form execution |
| Archive | Same mutate path requires version/open/owner, stores archived state and Evidence snapshot | Evidence retained; no reopen/deletion path |
| Scoped export | `export_csv` calls same `listing`; browser/MCP delegate to it | Scoped columns and spreadsheet-safe strings expressed, actual CSV not exercised |
| Partial import | Server-owned Intake, versioned correction then commit, per-row preview status, duplicate/exclusion/error outcomes and canonical mutate | Required review/outcomes expressed; framework transactions/savepoints assumed, not executed |

Browser and MCP call the same services with freshly verified principals; MCP transport is the official SDK stdio surface plus explicitly authored app token/adapter. This is a proposed supported configuration, not a tested staff-client connection. Authenticated browser provisioning of a short-lived token and rechecking password/membership are visible. Public OAuth/hosted chat onboarding is not claimed. C equally relies on its proposed MCP connection contract, so unavailable execution is not a comparative penalty on either side.

No mandatory source repair is requested for these eight bounded outcomes under the subject's stated assumptions. The Django attempt discloses a policy divergence from C: a private checkbox suppresses manager access, while nonprivate requests are department-manager-readable; C has no checkbox and treats manager visibility as the declared exception to owner privacy. Both were plausible responses to ambiguous wording. Its title maximum160, note maximum4000, CSV500 rows/1MB and duplicate signature also differ from C's inferred limits/contracts. These are **not exactly equivalent applications**. Record assumption burden and complete source/context counts, but do not turn their raw size ratio into a matched-behavior win. A rerun with fully pinned policies would be necessary for a quantitative superiority claim; it is not necessary to establish that ordinary requirements need clarification.

Later edits use the same pinned changes and preserve each disclosed baseline policy. Neither side receives an unrecorded repair. A is responsible for the comparison and evidence limits; B/C may challenge this static handoff. Django tests/runtime, Can examples/runtime, user usability, network and concurrent behavior remain unverified.
