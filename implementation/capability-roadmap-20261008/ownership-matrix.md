# Ownership and handoff matrix (SEQ-002)

This is a dated handoff map, not an ownership transfer or acceptance decision. Package ownership reflects the coordinator's 2026-10-08 report; compiler rows follow the compiler owner's newer report where older lease notes conflict.

| Owner/source group | Paths | Current state and boundary |
|---|---|---|
| Package coordinator | Git, `docs/specification/DECISIONS.md`, `docs/ideal-filetree-plan.md` | Retained ownership. |
| Package coordinator / UI implementer | `packages/ui/src/browser/bootstrap.ts`, `polling.ts`, lifecycle-cleanup test | Active lease; retain with current owner until release. Static compiler UI acceptance does not cover this work. |
| Package coordinator / files | `packages/files/src/upload/index.ts`, `finalize/index.ts`, `test/finalize-byte-count.test.ts` | Writers/readers released; commit in progress. The accepted byte-count scope covers localFS/persisted copies only. |
| Compiler completion owner | `compiler/src/analysis/types.rs`, `resolve.rs`, `tests/bdd_checked_facts.rs`, one `tests/codegen.rs` function | Handoff pending; BDD facts remain unaccepted pending independent review. |
| Compiler UI adapter | `compiler/src/codegen/ir.rs`, `js.rs`, `tests/ui_adapter.rs` | Static Card title and unbound Tabs accepted at bounded scope. Queries, bound/ordered tabs, profiles, and broader ownership remain open. |
| State/Cloudflare/stdlib guards | Guard source, runtime/stdlib export route, stdlib root and assembly test | Scoped synchronous guard exports and bounded revocation controls released; broader invocation ownership remains unresolved. Canonical reads, subject scope, durable/deployed routing, and broader roles remain open. |
| Package repair work | Identity, Cloudflare, values, files, services, state | Several narrow repairs have bounded accepted outcomes: fanout retry freshness, checkpoint outcomes, file finalization size, owned JSON, secrecy/read selectors, OAuth code consumption and S256 issuance, and selected provider byte cap/cancel identity. These do not qualify whole canonical, durable, provider, or app workflows. |

The coordinator retains Git, DECISIONS, and file-tree ownership; UI bootstrap/polling remains actively leased; files follow-on paths were released while commit is in progress. Root owns reconciling compiler handoff. No contested ownership is decided here.
