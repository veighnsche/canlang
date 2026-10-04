# Lane 05: Server-rendered UI and presentation library

Status: active coordinator. Worktree/branch/goal recorded below; B0 plan committed here; implementation in slices.

Owner prompt: [lane 05](../prompts/05-ui.md).
Worktree: /Users/vince/Projects/canlang-worktrees/lane-05-ui (owned; cleanup after all writers/viewers release).
Branch prefix: muse/lane-05-ui/. Planning branch: muse/lane-05-ui/plan (from origin/main b06d873).
Session: 01a10711-5461-7fc3-ad66-74706520a339. Native goal: goal-01a10713-71c2-78e1-b8ec-f78b19b4d5ee.
Coordination: in-process subagents sharing this one worktree with disjoint exact files, per lane prompt.
agents.py/tmux lanes were considered (bundled:agents read) and rejected: separate clones would violate
"no additional worktree/lead" and could touch the primary checkout's active draft writers.

## Current implementation evidence (inspected 2026-10-04, origin/main b06d873)

- No packages/ tree, no root package.json/tsconfig, no .github/workflows. L7 owns all three assemblies; none exist yet.
- All sibling status files (lanes 01/02/03/06/07) are "awaiting human launch". No producer contracts exist.
- Normative inputs read: DESIGN §9 (browser presentation), §9.1 (i18n), §12 (review), §13 (JS target,
  page descriptors, renderPage, message lowering); REQUIREMENTS prefab-components/shell sections; GRAMMAR (473 lines);
  examples/TeamTasks.can + ExpenseFlow.can Then pages; draft/CanFeedback.mjs UI factory usage (witness only).
- Draft witness (not a contract): lowercase factories take one props object with `context` + `children` arrays;
  `renderPage(c, descriptor, () => [...])`; `message(source, {locales}, {params})`; `list({..., renderRow})`.
  DESIGN §13 canonical: `renderPage(c, descriptor, children)` and descriptor
  `{owner,path,title,description?,order?,group?,nav?,admit,render}` with `admit(c,routeBindings)` returning
  server-private bindings. Lane 05 owns the final signature; see decisions.

## Settled planning decisions

1. Contract-first B0: lane 05 authors packages/contracts/src/presentation.ts now (self-contained, zero imports).
   L7 assembles packages/contracts/package.json + index.ts later. Until then, packages/ui tests import the
   contract via explicit relative path, marked temporary B0 wiring. No duplicate type definitions anywhere.
2. packages/ui is self-contained: own package.json, own strict tsconfig.json (no L7 tsconfig.base dependency),
   zero runtime dependencies in early slices; `typescript` devDependency only; tests run on node --test
   against tsc output. No root lockfile changes by this lane; route any future root needs to L7.
3. `renderPage(c, descriptor, children)` accepts a children array or a thunk returning (a promise of) an array.
   Canonical emitted form is the array; thunk accepted for draft compatibility. Documented in presentation.ts.
4. Server-rendered strings only. No `h`/JSX, no hydration, no browser business-state store, no second CRUD/policy
   engine. HTMX attributes + response headers carry interaction; business state stays server-owned.
5. daisyUI class names are emitted per the pinned mapping (REQUIREMENTS table); CSS delivery/tree-shaking stays a
   documented L7 assembly decision. A later slice adds daisyui as devDep with a class-audit test.
6. Locale-neutral exact value codecs belong to lane 2. Lane 05 owns message lookup/fallback, ICU-profile
   formatting shell, and display adapters with a documented seam for L2 exact adapters (BigInt-safe ints,
   decimal/money/temporal). No lossy Number conversion in lane 05 code paths.
7. DOM/keyboard/focus behavior tests graduate from string-level assertions (early slices) to a light DOM harness
   (linkedom/happy-dom evaluated in slice 5) to real workerd pages at B1 (L7 join). Snapshots alone never suffice.
8. Difficult choices (fragment region identity, unsaved-state preservation mechanism, DOM harness pick) use the
   repo three-rewrite JEV process; results preserved in implementation/evidence/jev/ lane-05 notes.

## Exact desired tree within ownership

```text
packages/contracts/src/presentation.ts   # L5-owned contract: descriptors, props, messages, bindings, fragments
packages/ui/
  package.json                             # owned manifest, zero runtime deps (early slices)
  tsconfig.json                            # owned strict config, self-contained until L7 base exists
  README.md                                # public @canlang/ui usage for generated code
  src/
    index.ts                               # public exports only
    catalog.ts                             # versioned machine-readable component catalog (Rust-consumable)
    escape.ts                              # HTML/text/attr escaping, safe message values, formula protection
    messages.ts                            # message descriptors, RFC4647 lookup, ICU-profile format, lang/dir
    navigation.ts                          # discovery: admit sharing, dedup/order/group, incomplete state
    shell.ts                               # renderPage, sidebar shell, account menu, settings dialog frame
    components.ts                          # card/title/text/content/list/table/board/calendar/metrics/copy/details/history/tabs
    forms.ts                               # form/edit/delete/action/actions, bindings, errors, conflict/pending
    collections.ts                         # search/filter/order/pagination/empty states, export/print controls
    htmx.ts                                # fragment responses, swap config, poll/refresh triggers, state markers
    settings.ts                            # preferences sections, locale/appearance controls, save/conflict
    review.ts                              # §12 source-derived company-policy review presentation
  test/
    fixtures/descriptors.ts                # hand-emitted TeamTasks/ExpenseFlow descriptors (until L1 emits)
    escape.test.ts messages.test.ts navigation.test.ts shell.test.ts components.test.ts
    forms.test.ts collections.test.ts htmx.test.ts settings.test.ts review.test.ts catalog.test.ts
.github/workflows/lane-05.yml             # typecheck + tests on owned paths
implementation/status/lane-05.md          # this file
```

Flat src/*.ts until a module exceeds ~600 lines or gains an independent worker; splits stay inside packages/ui.

## Interfaces and dependencies

| Need | Producer | Contract | Needed by | State |
| --- | --- | --- | --- | --- |
| contracts package assembly (package.json, index.ts re-export), root workspace/lock/tsconfig.base, workerd test harness, daisyUI CSS delivery | L7 | PLAN tree + CONTRACTS | B0 assembly / B1 join | Requested below; test-only relative import until then |
| Page descriptor/admit/render/message emission shape; catalog envelope/version join | L1 | presentation.ts (L5-authored, needs L1 ack) | B0/B1 | Proposed by lane 05; awaiting L1 launch |
| Exact display adapters (int/decimal/money/date/instant, plural-safe) | L2 | values.ts | forms/components slices | Seam defined; fixtures until then |
| Authorized projections, operation invocation, record/version bindings, history entries, policy data for review | L3 | state.ts | forms/review/B1 | Fixtures until then |
| Finalized file links, delivery status values | L4 | files/services | collections/media slice | Fixtures until then |
| Partial dispatch routes, CSRF, upload transport, shared operation metadata | L6 | wire.ts | htmx/forms/B1 | Fixtures until then |

Consumers of presentation.ts: L1 emission, L6 dispatch. No consumer implementation exists yet; test-only
fixtures in test/fixtures/descriptors.ts stand in for L1 output. No production stub is advertised as supported.

## Reused packages and qualification

- daisyUI/Tailwind (CSS only, late slice): class names per REQUIREMENTS mapping; audit test against installed
  daisyui version; CSS bundling is L7's decision. Not imported as JS.
- HTMX (attributes + headers only): no JS dependency in this package; swap/error-status config per DESIGN §9
  (explicit fragment swapping for validation/error statuses). Real browser behavior verified at L7 join.
- ICU MessageFormat profile: hand-rolled bounded parser for the DESIGN §9.1 subset (named args, number/date,
  plural/selectordinal/select, mandatory other; no offsets/choice/skeletons). Full-ICU library deferred; if a
  vetted workerd-compatible library fits, adopt with conformance vectors. Never another language's grammar on
  fallback text; locale data pinned by language version.
- DOM harness (slice 5): evaluate linkedom vs happy-dom under node --test for keyboard/focus/swap-state tests.
  jsdom only if lighter options fail. No harness decision before slice 5.
- Node built-in test runner + assert only; typescript devDep only. No test framework dependency.

## Subtasks and worker reservations

Coordinator implements slice 1 inline (contract + scaffold + escape/messages + CI). Later slices use at most
two implementation subagents with disjoint files; reviewers are read-only, never authors of the same slice.
Subagents never run git/worktree commands. Long commands: bash yield_time_ms 120000, reinspect on 1-5 min
cadence (default 2), no polling.

- [ ] S1 contract+scaffold: presentation.ts, ui package.json/tsconfig/README/index/escape/messages,
      test escape+messages+fixtures seed, lane-05.yml. Owner: coordinator. Branch: muse/lane-05-ui/s1-contract.
- [ ] S2 shell+navigation: navigation.ts, shell.ts (+settings dialog frame), discovery tests, renderPage tests.
      Branch: muse/lane-05-ui/s2-shell.
- [ ] S3 core components: components.ts (card/title/text/content/list/table + shared states), catalog.ts seed.
      Branch: muse/lane-05-ui/s3-components.
- [ ] S4 forms: forms.ts (form/edit/delete/action/actions, bindings, errors, conflict/pending), version hidden
      fields, datetime-zone controls. Branch: muse/lane-05-ui/s4-forms.
- [ ] S5 interaction: htmx.ts (fragments, swap/error config, poll/refresh), collections.ts (search/filter/order/
      pagination/empty/export/print), DOM harness decision + unsaved-state/focus tests. Two workers allowed:
      W-A htmx.ts+tests, W-B collections.ts+tests. Branch: muse/lane-05-ui/s5-interaction.
- [ ] S6 settings+panels: settings.ts (preferences sections, locale/appearance, save/conflict), tabs/details/
      drawer/history completion in components.ts, bound-tab preference save. Branch: muse/lane-05-ui/s6-settings.
- [ ] S7 rich controls: board/calendar/metrics/copy in components.ts, file/media controls, CSV import panel
      (import=csv + review), company review.ts. Two workers allowed: W-A components+tests, W-B review.ts+tests.
      Branch: muse/lane-05-ui/s7-controls.
- [ ] S8 catalog+B1 join: catalog.ts completion, B1 TeamTasks join evidence (real descriptors, routes, authority),
      B2/B3 journeys, cleanup handoff. Branch: muse/lane-05-ui/s8-join.

## Test cases (each slice ships its own; acceptance accumulates)

- Escaping: XSS vectors in text/title/content/columns/labels/ids/URLs never produce raw markup; attr/JS contexts
  covered; CSV formula protection; forbidden fields absent from HTML even when present in input records.
- Messages: RFC4647 lookup order, app-default then source fallback, equal-match tie order, missing-variant
  reporting, ICU subset (plural/select/number/date), BigInt-safe exact cases, lang/dir/bidi isolation output.
- Navigation: declaration-order preservation, (owner,route) dedup, order/group/nav=none semantics, dynamic-route
  exclusion, admit denial vs unavailable (generic incomplete state, no count/grant leak), static metadata only.
- Shell: sidebar structure (brand top, nav scroll, account bottom), collapse/overlay, account menu items by auth
  state, settings dialog focus containment/return + section sidebar + mobile, theme-token mapping, context-switch
  data clearing markers.
- Components: list/table bounded pagination + cursors, split-pane empty/selected states, drawer single-activation,
  tabs keyboard/panel association + inactive preservation, history grant projection + secrets exclusion,
  board/calendar/metrics compositions, copy clipboard wiring, empty vs no-match states.
- Forms: typed bindings (record/version hidden, protected args), input errors with values preserved, pending/
  conflict/failed/unknown outcomes, conflict shows current authorized values without overwriting draft,
  datetime-zone adapter (nonexistent/ambiguous handling), picker opaque references, CSV import review flow.
- HTMX/interaction: fragment responses for validation/error statuses swap correctly, HX-Push-Url/title coherence,
  unsaved values/focus/open controls preserved across swaps, expired-auth full navigation, poll GET-only with
  single in-flight + visibility pause, refresh explicit-submit chaining with fresh identity per repeat.
- Settings/i18n: preference save/version checks, invalid/revoked fallback with feedback, preview revert/confirm,
  every preference field has a presentation consumer, locale selection order (saved > priority > default).
- Review: §12 view traces each outcome to declaration+example, unconfirmed intent labeled (never invented),
  missing evidence/contradictions shown, revision staleness invalidates old review.
- Catalog: versioned export lists every component with props; checked against implementation (no drift).
- Journeys: B1 TeamTasks two-user browser+MCP denied/stale/replay; B2 ExpenseFlow attachment/approval/notice;
  B3 migration form errors + policy inspection. All on real routes with real authority at L7 join.

## Integration joins and PR order

1. S1 PR: contract + scaffold + escape/messages + CI. Joins: L1 ack on presentation.ts; L7 contracts assembly.
2. S2 PR: shell + navigation. Joins: L6 dispatch shape check (admit/render reuse).
3. S3 PR: core components + catalog seed. Joins: L2 adapter seam review.
4. S4 PR: forms. Joins: L3 invocation/binding shape; L6 upload/CSRF shape.
5. S5 PR: htmx + collections. Joins: L6 partial dispatch; DOM-harness evidence.
6. S6 PR: settings + panels. Joins: L3 preference storage shape (read-only consumption).
7. S7 PR: rich controls + review. Joins: L4 file/delivery values; L1/L3 policy-data shape for review.
8. S8 PR: catalog completion + B1/B2/B3 evidence. Join: L7 workerd runner, real emitted descriptors.
Each PR: rebase on origin/main, focused checks (typecheck + affected node --test), real diff self-review,
bounded read-only subagent review for meaningful semantics, squash-merge reviewed head only when green and
permitted. No bypass flags. Next slice branches from fresh origin/main in this same worktree.

## Interface requests and handoffs

- To L7 (blocking assembly, needed B0): create packages/contracts/{package.json,src/index.ts} re-exporting
  src/presentation.ts (L5-owned content, appended verbatim); root package.json/tsconfig.base.json/lock wiring
  for packages/ui; confirm daisyUI CSS delivery owner. Lane 05 will rebase its temp relative import onto
  @canlang/contracts when available. Recorded 2026-10-04; L7 not yet launched.
- To L1 (needs ack, B0/B1): presentation.ts proposes descriptor/admit/render/message/catalog shapes. L1 emission
  must produce them; catalog envelope/version join per CONTRACTS. Recorded 2026-10-04; L1 not yet launched.
- To L2/L3/L4/L6: seams + fixture shapes defined in S1/S4; exact producer types adopted on arrival, fixtures
  retired per slice. None launched yet; no lane blocked since fixtures are test-only and explicit.

## PR and verification evidence

### S1 contract + scaffold + escape/messages (branch muse/lane-05-ui/s1-contract)

Files: packages/contracts/src/presentation.ts; packages/ui/{package.json,package-lock.json,
tsconfig.json,README.md,.gitignore,src/{index,escape,messages}.ts,
test/{escape,messages}.test.ts,test/fixtures/descriptors.ts}; .github/workflows/lane-05.yml;
this status plan.
Checks (local, node v24.21.0): `npm run typecheck` clean; `npm test` 48/48 pass
(escape 25, messages 23 incl. TeamTasks task-count en/nl, exact-number plural priority,
64-bit French/Arabic categories, money/date/time, ICU error cases, Intl cross-check
over en/nl/fr/hi-IN/ar-EG/de-CH, quoted-# literals, datetime rollover rejection).
Decisions sealed in code: descriptor bound params used when explicit args absent;
ESM-only emit (module ESNext) so the out-of-scope contract file compiles consistently;
CI uses npm ci with the owned lockfile.
PR #7 (muse/lane-05-ui/s1-contract -> main). Self-review: full diff inspected, all
14 files in ownership; verified escaping sinks, lookup order, no root writes.
Independent read-only subagent review: approve-with-follow-ups; findings F1 (canonical
dotted enum ids), F2 (datetime rollover), F3 (quoted #), F4 (locale grouping/digits)
and nits N1-N4 all fixed in-branch with regression tests before merge.
Merge: (to be filled) reviewed head sha, checks, squash merge result.

## Remaining work and cleanup

Full lane scope per subtasks S1-S8. Owned resources: this worktree only; no build caches beyond packages/ui/
node_modules (owned, disposable). No producer/docsandbox writes. Cleanup of worktree after final merge +
writer/viewer release; never delete shared caches or unrelated processes. Known risks: L7 assembly timing
(temp import seam), L1 emission-shape drift (mitigated by L5-authored contract + fixtures), DOM-harness
selection (slice 5 evaluation), daisyUI version pin (class audit in components slice).
