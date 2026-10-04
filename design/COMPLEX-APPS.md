# Complex company-app draft completion

Active Codex goal, 2026-10-04. The user assigned the creative design **and actual drafts** to Codex/Astra. The nine named apps are mandatory; further apps are added only for demonstrated business or capability gaps. This is separate from the seven human-launched production implementation lanes.

## Outcome

Each app has company-specific requirements, a complete `.can`, and its consistent handwritten desired `.mjs`. They describe useful real workflows with current authority, evidence, recovery and UI. They are not running implementations. Finish the sources and contracts rather than using missing runtime code as a reason to leave business behavior unspecified.

Read [the initial research](AI-AND-SERVICE-DRAFTS.md), current REQUIREMENTS/DESIGN/GRAMMAR, and the actual neighboring app exports before changing anything. Proposed syntax in old research is not adopted automatically. App descriptions and labels stay inline; shared components inherit the shell, settings and HTMX behavior. No raw HTML, `h` calls, extra app manifests or provider secrets in source.

## Owners and sequence

| App | Required journey | Creative owner | State |
| --- | --- | --- | --- |
| CanChat | Private conversation, streamed partials, reconnect, stop, explicit retry/branch and authorized attachments | Astra chat/media | Actual triplet written and independently reviewed |
| CanCreative | Employee-configured pinned ComfyUI graph/node mappings, generation budgets, partial variants and review | Astra chat/media, after Chat lifecycle | Actual triplet written and independently reviewed |
| CanGallery | Approved media and permissioned collections with immutable provenance and withdrawn-access behavior | Astra chat/media, after generation/file boundary | Actual triplet written and independently reviewed |
| CanInbox | Typed NOUL/choice/score classification, uncertainty, corrected routing and response recovery | Astra Inbox | Actual triplet written and independently reviewed |
| CanDiscover | Recurring bounded multi-source research, coverage/citations, dedupe and reviewed CRM promotion | Astra Discover | Actual triplet written and independently reviewed |
| CanSync | Conditional external synchronization, authority per field, rate limits, conflicts and unknown-write recovery | Root | Actual triplet written and independently reviewed |
| CanKnowledge | Authorized revisioned retrieval/citations, stale indexes, grounded answers and owner escalation | Astra knowledge | Actual triplet written and independently reviewed |
| CanEnrich | Bounded provider waterfall, retained paid successes, per-field provenance and reviewed application | Root; independent Astra review | Actual triplet written and independently reviewed |
| CanWorkbench | Closed canonical tool set, bounded steps/spend, exact-argument approval and fresh authority at invocation | Astra workbench; independent review | Actual triplet written and independently reviewed |

Root owns shared contract consolidation and cross-app consistency; each app owner owns only its named triplet and focused design/evidence. H007/H008 explicitly released these app paths and the old Muse Git index to Codex; independent human-launched work may still use the shared checkout, so commits are path-restricted. H007 is acknowledged and explicitly releases N01–N09 and all affected app paths to Codex/Astra, preventing accidental Muse dispatch. Do not edit Muse's checklist or reserved sources. No new Muse session is launched.

## Minimum shared questions to settle against the apps

- Typed provider operations: one canonical send path, binding-scoped destinations/credentials, bounded responses and exact decoding. External success, committed company action, unknown result and partial result remain distinct.
- Observable generation: partial versus final content, sequence/reconnect, current read authority, stop request versus confirmed stop, independent request cancellation and retained usage. Compare existing capability events/receipts with a small shared contract extension before imposing repeated app orchestration.
- Judgment specifications: question kind, choice IDs and ordered rubric declared once; derive result types/distributions and show uncertainty. Company routing thresholds are business policy, not provider defaults.
- Bounded research/retrieval: durable continuation, stable job identity, coverage, versioned citations and access recheck. Query limits reject excess; they are not pagination.
- Configurable ComfyUI: immutable graph and mapping revision, typed node/key selection, version/feature validation, safe job-specific cancellation, final file provenance and partial outputs.
- Business-tool use: use owning operation signatures, current actor/team/grants, protected record versions and precise approved argument values. No generic model-authored privileged code or runtime-discovered arbitrary tool execution.

Each accepted contract must have a concrete source and desired-JS witness, one owner, ordinary failure semantics and consumers. Consult JEV for difficult choices with three equivalent, fully reworded balanced payloads; retain probabilities/uncertainty and investigate disagreement. Existing rejected payloads are not bypassed. Research providers from primary sources; classifier advice cannot establish API behavior.

## Completion per app

- [x] Requirements cover purpose/adoption, users/permissions, data/ownership, workflows, UI/settings, interfaces, background work, errors and limits; company policy is explicit where it matters.
- [x] The actual `.can` defines every required transition and recovery path with canonical operations; shared infrastructure is not duplicated as company models/handlers merely to hide a primitive gap.
- [x] UI includes the complete normal and failed/partial/conflicting/revoked journeys using shared components and declaration-derived forms; every preference has a consumer.
- [x] Business examples include independently stated success, rejection and recovery outcomes. Deterministic provider/file fixtures never perform live calls or fabricate finalized files.
- [x] `.mjs` preserves declarations, current guards, effect order, values, query authority, UI bindings and every example using DESIGN §13. Proposed imports are labeled and have an explicit contract; no string interpreter or app-specific helper hides missing translation.
- [x] Target syntax and supported source syntax are checked; unsupported prototype forms are precisely disclosed. One focused semantic/source-target review resolves material findings. Structural checks are not runtime/security evidence.
- [x] Changed shared semantics and implementation-lane impacts are documented; coherent exact-path commits are made after Git ownership is obtained.

Complete the nine before considering optional new apps. Useful later candidates are a reviewed meeting-to-actions workflow or an invoice discrepancy pack, only if they demonstrate needs absent from these nine and the existing portfolio. Do not expand the goal indefinitely to chase an undefined perfect language.

## Progress evidence

Historical starting inventory: no app triplets existed yet for the nine names; existing portfolio has 39 `.can` and 21 `.mjs`. Root persistent goal created. H007 ownership transfer requested. Three focused creative assignments launched; root investigates synchronization and shared interfaces. No app or runtime completion claimed.

2026-10-04 checkpoint: H007 explicit release verified. CanChat and CanDiscover sources are being authored. Root completed the CRM reviewed-research intake source/target/requirements dependency; its target syntax passes. Accepted draft extensions are the standard TextGenerationV1/ImagesV1/MailboxV1 contracts, a single authored judgment declaration with derived evaluate/result typing, and a pinned JSON file recipe for workflow mappings. DESIGN/GRAMMAR link the normative catalogs; no implementations are claimed.

## Language burden review — required, not optional polish

The user reiterated that these harder apps exist to discover and improve primitives, not to prove that enough app code can emulate everything. App completion therefore also requires identifying repetitive protocol mechanics and either removing them through an accepted shared language/library contract or explaining their company-specific meaning with a concrete witness. Old grammar is not a constraint on a better draft design.

| Pressure | Current decision | Evidence / next step |
| --- | --- | --- |
| Repeated judgment questions, option enums and result maps | Adopted `judgment` Given declaration; derive typed evaluate/result/specification | CanInbox + normative catalog; saved three-way consultation |
| Image review rendered as generic file links | Adopted `gallery` Then component | CanCreative/CanGallery; current file/field authority on preview |
| Generation sequence/state/content mirrored into every app | Adopted protected `delivery.progress` + `Target.progressed` sourced once by observable standard interfaces | Actual Chat/Creative sources removed eight callback bridges and protocol mirrors; one business settlement handler each |
| Frozen model-proposed operations copy owner schemas and approval envelopes | Adopted typed full invocation values derived from a closed list of owning operations | Workbench owner; exact args/versions + real current caller, never implicit authority |
| Index freshness/retrieval grants repeated as app chunk/cache/ACL plumbing | Adopted model-bound `corpus` plus protected grounded answer | Knowledge actual witness; publication/audience/escalation remain app policy, all used-source access is rechecked |
| Synchronization conflict resolution | Three-field company policy explicit; conditional requests/transport/decoding shared | CanSync; safe field rebase and unknown-write hold are deliberate business behavior |
| Pure selection between safe already-typed values | Adopted `choose(bool,T,T)` ordinary eager standard value function | CanSync; no alternate conditional grammar, no null narrowing |

Root received H008 Git index release and committed the independently completed CRM dependency as `b3c78fc`. All other app writers retain their scoped ownership; no implementation lane was launched or modified.

## Reviewed milestones

- `b3c78fc`: CRM reviewed idempotent research promotion, an actual Discover dependency.
- `706c70a`: Inbox/Discover/Sync triplets, evidence and independent repairs. A concurrent writer staged frontend planning docs between the explicit stage and commit, so that commit also preserves their planning work. No reset/rewrite was performed. Later commits use `git commit --only -- <explicit paths>` to keep unrelated staged work out.
- `3d41233`: Chat/Creative/Gallery actual triplets, accepted progress contract, consultation evidence and independent review corrections. Published Creative revisions explicitly share their validated graph while active; draft graphs remain private.

Current review corrections include exact result descriptors, canonical expression-order keys/directions, nested fixture exports, shared UI argument shapes, Unicode trim helpers, and meaningful fresh-version sequence assertions. These are correspondence checks, not executed business/runtime evidence.

## Additional demonstrated witness — generated decision inputs

The user identified a concrete missing journey after the original nine: an LLM generates the state **and the candidate choices** that JEV evaluates. Inbox has fixed source-authored choices; Workbench generates tool proposals without JEV. Neither is coverage of this pipeline. CanDecide is therefore the single justified additional app, owned by the released focused Workbench/Discover worker.

Its bounded company outcome is reviewed process-change decisions: retained original evidence → structured generated state/options → employee correction/freeze → fixed NOUL/score and dynamic choice evaluation over that same revision → explicit employee decision. Confidence is not proof that evidence or candidate framing is unbiased. No decision automatically executes business mutations. A minimal extension/reuse comparison and three balanced consultations precede adoption; root owns shared rules, the worker owns the new triplet/catalog/evidence. This is an addition to the existing goal, not a reason to redo or delay the nine reviewed drafts.

- `13071ec`: reviewed Workbench/Enrich triplets and the owning CanDo completion export, with bounded independent review evidence.

## Original nine — draft acceptance checkpoint

All nine named triplets are complete at the declared draft stage and have focused independent review with material repairs applied. [Final file hashes and syntax results](complex-apps/nine-app-verification.json) identify the accepted revision. Existing source/target checks match inventories and callable registry references; bounded Can projections cover only supported ordinary syntax. The full prototype still lacks adopted constructs, and no BDD, provider, renderer, concurrency or runtime execution is claimed.

The new primitives are not placeholders for missing app behavior: actual sources use judgment, associated progress, full invocations, corpus and gallery; corresponding JavaScript descriptors/calls derive their shared schemas. Company budgets, publication, decisions, routing, conflict recovery and authorization remain explicit. Cross-app review repaired Unicode trimming, fixture dependency lowering, receipt disclosure, query ordering, result metadata and lazy UI builders.

CanDecide remains the one user-requested extension in progress. Its generated state/dynamic choice contract is not included in this nine-app acceptance or treated as already implemented. The persistent goal stays active until that new witness is resolved and reviewed too. The broader historical portfolio/migration has separate outstanding work.
