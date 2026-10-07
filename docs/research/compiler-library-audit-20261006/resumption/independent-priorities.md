# Independent implementation priority review

**Historical initial-resumption review.** The source observations and unreleased statuses below describe the pre-repair compiler snapshot. Current committed outcomes, later BDD/query findings and remaining gates are reconciled in [the resumption receipt](README.md); do not read the old queue/sanitizer/notification descriptions as current behavior.

Read-only review completed against current source (no compiler changes since the audit's identical tree snapshot). Historical docs propose rather than release implementation; latest user/root authorization releases bounded existing-contract repairs, without waiving owner/policy gates.

There are 30 explicit finding records: SYN 8, SEM 8, OUT 5, ED 9. Step6 separately lists 10 integration retirement candidates (22 dependency/result records are not 22 repair packets). Representation-cohort enforcement and workflow endpoint gaps are additional unnumbered qualification work. Current failure-evidence is new Step12 work and should not be silently excluded or double-counted as historical acceptance.

## Safe ordered writer lanes

1. types.rs: SYN-R02 source-header metadata and SEM-R01 nullable array join. Preserve malformed header locality; test both nullable orders, expected arrays and ordinary controls. No locale/data policy change.
2. effects.rs: SYN-R01 independent-owner/File recovery and SEM-R02 recurring derive/query dependencies. Preserve local dependent suppression, policy tables, E4011/E4020/E4004 controls, E4051 direct/scenario/derive forms. Creation-default/server initializers remain separate.
3. server.rs (+ output.rs and queries.rs only needed): ED-R04 close clear, ED-R08 queued epoch/shutdown, then ED-R05 reference/edit capabilities. Current queue is URI+version only; reopen can revive old work. Notification output currently discarded by handle_json. References callbacks have no includeDeclaration option; avoid unnecessary public trait break by subtracting actual declaration locations using existing definition identity or a query helper. Workspace edit DTO always documentChanges; support changes fallback and both rename/code-action callers.
4. js.rs: OUT-R01 reserved/context/temp binding correctness is released but substantial. IrExpr::Name carries String whereas callable params carry SymbolId. sanitize_ident is shared across binding and property/wire places. Cover all callable parameters/read sites, locals, lambdas/query aliases, object shorthand, generated temporaries/import names/module allocations; scope mapping must keep authored property names. Node syntax-only witnesses are insufficient: invoke generated callables with actual contexts. No new JS AST needed.
5. client.ts/extension.ts: ED-R01/02/03 already allocated separately; avoid shared writers with server changes. Actual GUI apply remains distinct from strict host stand-in conversion acceptance.

11 historical records above are immediate existing-contract correctness candidates; ED-R05 splits into two units, hence 12 work units. BDD quote consolidation adds one independent mechanical integration record, but touches js.rs and bdd.rs and requires at least 3 net production lines removed through complete quote closure.

## Complete historical finding table

| Packet | Status / owner / remaining gate |
|---|---|
| SYN-R01 | Released existing contract; effects.rs; independent valid siblings, local suppression |
| SYN-R02 | Released existing contract; types.rs; valid owner header only |
| SYN-R03 | Owner seam qualification; ir.rs; tab caption + descendants through actual factory |
| SYN-R04 | Owner seam qualification; ir.rs; structured order UI/runtime contract; serialize R03 |
| SYN-R05 | Support release; resolve/types/effects/ir; corpus must retain semantics or reject, judgment separately fail-closed |
| SYN-R06 | Consequential recovery/JEV; layout/parser; preserve genuine multiline nesting |
| SYN-R07 | UI owner finite profile release; parser/types/ir/js; availability whitelist is insufficient |
| SYN-R08 | Witness/prose maintenance; no new Decimal backend; permanent actual consumer regressions |
| SEM-R01 | Released existing contract; types.rs; one nullable element join policy |
| SEM-R02 | Released existing contract; effects.rs; use bound derive/query dependency facts |
| SEM-R03 | Owner signature seam; ir/js + stdlib/values; named binding, values/options, locale, evaluation once/order |
| SEM-R04 | Email floor/JEV; types.rs + public codec owner; no second large parser |
| SEM-R05 | Format/date vs datetime and timezone data qualification; examples/types + owners; no midnight heuristic |
| SEM-R06 | Package UI validation + generated carrier seam; UI owner; year 0001/0099, integer/ordinal Decimal and actual emitted carrier |
| SEM-R07 | Existing graph witness policy/JEV; types.rs; edge scopes/upstream/multiplicity/anchors/seed order |
| SEM-R08 | Leads, not broad release; trial state, unknown nominals, scalar/default/bytes/full handoffs need bounded witnesses |
| OUT-R01 | Released binding contract; js.rs; complete scoped binding closure and executable consumers |
| OUT-R02 | diagnostic.rs public sort guarantee clarification; tags-only tie, actual CLI tied producer absent |
| OUT-R03 | interfaces docs owner; Markdown backticks/pipes/backslashes through public renderer |
| OUT-R04 | lint comment-attachment policy/JEV; rules.rs; runtime-safe removal is not comment preservation |
| OUT-R05 | Qualification collection; modes/hosts/maps/Decimal/client actual application; no generic implementation release |
| ED-R01 | Released client currentness; client.ts; one live revision/epoch authority |
| ED-R02 | Released provider currentness/cancellation; extension.ts + client seam; strict host apply/no-apply and GUI distinction |
| ED-R03 | Released host enum identity; extension.ts + ambient client types; no assumed LSP/VSCode equality |
| ED-R04 | Released server close clear; server/output; real wire + client; late delivery separate |
| ED-R05 | Released supported options; server/output/query; false excludes declaration; capability-negotiated edits |
| ED-R06 | Retention ownership/resource policy; server/source/lint; immutable checked cohorts and measured representative edits |
| ED-R07 | Workspace/catalog support policy; server/query/editor/docs; static single-doc scope contrasted, no automatic workspace engine |
| ED-R08 | Released public queue robustness; server; reopen epoch and shutdown; synchronous stdio not async defect |
| ED-R09 | Startup/lifecycle source leads; client/extension; qualify delays/errors/timeouts/restart/write failures before fixes |

## Integration candidates (10)

Only BDD quote consolidation is a mechanical simplify candidate. JSON reader coupling, docs legacy views, policy layout, default JSON string bridge, source-map extraction, public map decoder, LSP render builders, public descriptor/fix fragments and LSP position carriers retain explicit public support/representation/oracle contracts. Existing raw numbers/duplicate order/depth/error anchors and exact bytes cannot be discarded merely because current internal callers parse fields. Public nonuse is not retirement authority. No JEV is needed to show existing correctness violations; consequential alternatives require verified context.

## Omissions that must remain visible

- New Step12 actual legal flat arithmetic input aborts: 1024 terms parse/check clean but compile SIGABRT; 2048/3000 parse clean but check/compile abort. Precise later recursive traversal/clone/lowering/drop stage is unassigned, and debug-host thresholds are not portable policy. This is severe distinct correctness/resource follow-up.
- Public emit mixed source/catalog cohorts remain admitted; normal CLI owned analysis is coherent. Enforce only after owning public preconditions are released, not blanket claim CLI stale output.
- Platform test reports executed:0 and does not join generated examples; run/build/activate are structural receipts rather than generated app execution; deploy can exit0 with applied:false. Current contracts need truthful qualification/owner decisions, not compiler forwarding rewrites by implication.
- Package source and built dist are separately pinned; rebuild actual consumer package for acceptance where source is changed.
- Modes4750, actual GUI apply/navigation, broader source-map runtime attribution, original/installed product and other hosts remain incomplete. Finite harness counts cannot certify these profiles.

No production edits/tests/builds were run during this review. Shared docs/decision/ledger/commit writers remain root-owned. Recommended commits: server close+epoch+shutdown cohesive, then reference option, then capability edit carrier if these changes stay independently reviewable; test coverage should accompany each release.
