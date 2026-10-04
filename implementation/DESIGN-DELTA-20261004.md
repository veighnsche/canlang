# Complex-app draft design delta — 2026-10-04

Codex-owned notice to the seven human-launched implementation lanes. This is a design input, not a new dispatched implementation task or a claim of implementation. Existing lane owners retain their files; read at the next ordinary planning boundary. The user explicitly authorized new primitives discovered by the complex apps. No Muse session was started by Codex.

The normative draft has added:

| Change | Primary owners / effect | Witness |
| --- | --- | --- |
| Given `judgment` | L1 syntax/types/schema extraction; L2 exact result/spec validation; L4 provider mapping; L5 displays | CanInbox, DESIGN §8.2/§13.1 |
| `delivery(Target).progress` and `Target.progressed` for declared observable originals | L3 receipt projection/fences; L4 correlation/normalization/durable notifications; L1 generated members; L5 authorized displays | CanChat/CanCreative, DESIGN §8.1/§13.4 |
| `invocation(Operation,...)` complete immutable call values | L1 type/schema extraction; L2 normalized values; L3 canonical current-caller invocation; L4 validated model output; L5 exact preview; L6 MCP parity | CanWorkbench, DESIGN §2.2/§13.4 |
| Given `corpus` with protected grounded answers | L1 declaration/schema; L3 authority/version fences; L4 indexing/retrieval; L5/L6 current disclosure and as-of presentation | CanKnowledge, DESIGN §8.3/§13.5 |
| `gallery Query image=field` | L1 collection grammar; L5 shared accessible image preview; L4 file provenance | CanCreative/CanGallery |
| JSON finalized-file recipe | L4 files; L7 fixtures | Pinned small mapping sample, not a claimed executable ComfyUI workflow |
| `choose(bool,T,T)` eager pure value selection | L1 checking; L2 pure values | CanSync, DESIGN §3/§13.2 |

Standard typed TextGenerationV1, ImagesV1 and MailboxV1 catalogs are normative references from DESIGN §8.2; adapters remain unimplemented draft contracts. Stop/reconcile are ordinary typed sends. No duplicated app progress state machine or compiler knowledge of provider endpoints is intended.

Canonical generated collection values use `items` (with `contract` for typed structural rows), while model collections use model/parent/where/order and renderRow(row,rowView). A few older handwritten Feedback table witnesses used `rows`; that target inconsistency needs consolidation. If an implementation already shipped the older prop, coordinate a compatible alias/transition with L5 before removal. This document does not authorize another lane to overwrite L5 source.

The current Python prototype lacks several earlier and new forms; unsupported prototype syntax is not proof these adopted drafts are invalid. Production conformance must be explicitly owned, with no silent fallback. The nine new app triplets and user-requested CanDecide witness have completed focused independent draft review and syntax checks; see design/COMPLEX-APPS.md and its acceptance evidence. CanDecide extends the same judgment contract with `options=runtime`; its reviewed source and desired target preserve the approved specification revision before evaluation and before the attributed human decision.

Expression-query ordering has one explicit target descriptor, `order:{by:row=>key,direction:"asc"|"desc"}` (ascending may omit direction). UI selector ordering remains `["-created"]`. This prevents invalid numeric negation of datetime/text keys and consolidates divergent handwritten target sketches.

New target examples return `exampleFixtures(...) -> {fixtures:{...},examples:[...]}` consistently. Some historical handwritten targets returned recipe names at the top level; that ambiguity is retired in the nine new apps. A runner consuming old artifacts needs an explicit migration/compatibility boundary rather than silently supporting multiple authored conventions forever.

Table `seed` source recipes lower into the same deduplicated `dependencies` list as baseline references; there is no separate target `seed` property. Result metadata uses field descriptors (type plus array/nullable/requiredArray where appropriate), and page body builders are lazy under the admitted page context.

Runtime choice extends the existing judgment descriptor with `runtime:true`. L1 derives per-question option types and closed `Name.options`; L2/L4 validate the combined frozen choice set and complete distributions; L5/L6 retain exact reviewed state, candidate identities and advisory results. Static judgments are unchanged. `Name.specification(options)` derives the complete normalized spec without another handwritten DTO; fixed+runtime options must total 2–26, with no collision or silent truncation. Authored fixed choices are optional; company-specific escape choices are not global defaults. See design/complex-apps/decide.md#runtime-choice-contract for the accepted contract; no lane is dispatched by this notice.
