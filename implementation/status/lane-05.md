# Lane 05: Server-rendered UI and presentation library

Status: active coordinator. Worktree/branch/goal recorded below; B0 plan committed here; implementation in slices.

## Scope steering (2026-10-04, user-approved)

implementation/briefs/05-ui.md + design/UI-COMPONENTS.md supersede the small-subset completion criteria: lane 05
must deliver the entire approved 68-component typed catalog and UI library (daisyUI 5.7.47 pinned), the shared
static RIGHT-sidebar shell (page menu, bottom-right user menu, common user configuration dialog, canonical login
screen), and L1 discovery/emission coordination. The old S1–S8 small-inventory checklist below is preserved as
history; completion is now defined by the correction slices C1–C9 and the 68-component coverage ledger. S1–S5
merged work stands (shell/forms/htmx/collections/i18n foundations); C1 corrects the shell, C2 ships the full
catalog contract, C3–C8 implement component families, C9 completes B1/B2/B3 + discovery evidence. Lane 08 owns
draft/.can migration; lane 05 never edits draft/, examples/ or product .can files.

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
- [ ] S2 shell+navigation (branch muse/lane-05-ui/s2-shell, in progress):
      (a) Adopt L7 root workspace (precedent: lane 06 S1): ui tsconfig extends base
      (composite false, rootDir ..), member lock dropped, CI root-install +
      workspace test + owned-import guard; request L7 join presentation.ts into
      contracts index + packages/ui into tsconfig.check.json. Coordinator files:
      packages/ui/{package.json,tsconfig.json}, .github/workflows/lane-05.yml,
      packages/ui/README.md, this status file. (b) Contract amendment (coordinator):
      CSRF_FIELD, NavigationResult/NavGroup/NavEntry, ShellData/AccountMenu/
      SettingsSections/Routes, RenderPageFn in presentation.ts. (c) W-A:
      packages/ui/src/navigation.ts + packages/ui/test/navigation.test.ts +
      test/fixtures/descriptors.ts extension (full descriptors with stub
      admit/render). (d) W-B: packages/ui/src/shell.ts + packages/ui/test/shell.test.ts.
      S2 pins: data-theme="can-{mode}-{accent}" token names + density class emitted;
      themes.css + daisyUI version pin deferred to S3 class-audit slice; sidebar
      collapse is CSS checkbox in S2, device-local persistence in S5; settings modal
      frame + section sidebar in S2, base panels in S6.
      Worker runs: first W-A/W-B pair cancelled by turn boundary before starting
      (no files written); respawned as lane05-s2-nav2/shell2 with full
      self-contained briefs. origin/main advanced (lane 04 S2 #5, disjoint files);
      rebase at S2 PR time.
      Correction (S2 review B3): the "CSS checkbox collapse in S2" pin was wrong —
      S2 ships mobile overlay (checkbox) + always-open desktop; desktop collapse
      control + device-local persistence are explicitly deferred to S5 (owned
      script). Follow-ups recorded: aria-modal/focus containment/return + Escape
      for drawers/dialogs (S5/S6); panelHtml trust boundary becomes an S6
      escaping requirement; caption datetimes render in UTC until a
      PresentationContext timezone field lands (L6 join). License field removal
      in ui package.json is intentional (matches @canlang/identity precedent,
      private:true).
- [ ] S3 core components (branch muse/lane-05-ui/s3-components, in progress):
      Tree refinement: list/table renderers seed collections.ts (S5 adds
      controls there); components.ts holds card/title/text/content/states/values.
      Query-seam decision (needs L1/L3/L6 ack): factories keep the DESIGN §13
      call shape `table({context, model, columns})` where context is the
      dispatcher-built PresentationContext carrying `invocation` (canonical ctx,
      opaque) + `query` (RowQueryRunner bound to authorized records()). UI never
      queries except through the runner; no second engine. ListQueryResult
      carries rows + nextCursor + column metadata (labels/types/valueLabels from
      loaded appDefinition via the runner). TextValue = string|boolean|bigint|
      number(safe-int only)|MessageDescriptor|MessageParamValue|null|undefined;
      raw non-integer numbers rejected (decimals need {type,value}).
      Coordinator: presentation.ts v0.3.0, messages.ts (resolveCaption,
      formatScalar), shell.ts resolveText refactor, themes.css + daisyUI audit,
      catalog.ts + tests, index wiring, README, status. W-A: src/components.ts
      + test/components.test.ts. W-B: src/collections.ts + test/collections.test.ts.
      Shared worker specs: renderTextValue(value, context)->escaped HTML and
      rowHeading(row, modelCaption, context)->escaped text exported from
      components.ts; resolveCaption/formatScalar from messages.ts.
- [x] S4 forms (branch muse/lane-05-ui/s4-forms, PR pending): contract v0.4.0
      (FormProps/EditProps/DeleteProps/ActionProps/ActionsProps, FormFieldDef,
      FormOutcome, DeliveryReceiptView; reuses wire FieldError/BusinessError/
      MutationRef/SealedActionHandle + services DeliveryStatus via type imports).
      Field-encoding proposal (L6 ack): urlencoded POST to dispatcher action URL;
      hidden operation/operation_id/CSRF/timezone (+record/action_handle);
      `inputs[root][key]` brackets (update roots at inputs[changes]); error
      pointers map to bracket names; action_handle as opaque hidden JSON.
      W-F delivered src/forms.ts + test/forms.test.ts (74 tests); coordinator
      reconciled: timezone always declared (UTC default), conflict.current as
      L3 CurrentRow projection, gap-2 allowlist, separator-adversarial routing
      regression test. Suite 257/257 green. Read-only review closed (0 real
      defects; drawer finding false-positive; A1 fail-closed verified).
- [x] S5 interaction (branch muse/lane-05-ui/s5-interaction, PR pending): contract v0.5.0
      (CollectionControls/FilterCondition/OrderSelector, HtmxRequest/StatusSwap/FragmentRegion/Poll/StaleMarker,
      no-match kind). JEV 3-rewrite: morph-by-default on stable region ids, innerHTML for explicit reset only
      (evidence/jev/lane-05-s5-20261004/, unanimous A, weak 2/3). Harness: happy-dom 20.14.5 measured pick,
      linkedom disqualified (activeElement). W-A: src/htmx.ts + test/htmx.test.ts (40 tests). W-B: collections
      controls + tests (toolbar/pagination/export/print/no-match). Coordinator reconciled: renderState no-match
      case, harness DOM types, can-region hook, index/catalog wiring. Suite 333/333 green.
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
- To L1 (HO-05, C2a): 68-word catalog PR #42 (v0.7.0) shipped; L1 ACKED 2026-10-04 — envelope aligns with IR-01
  modulo per-kind extras; L1 PR4 consumer accepts common-base + per-kind extras, returns missing-fields list
  (candidates: attribute value types/co-occurrence, slot content schemas, header payload types); L5-entry
  checking in L1 PR5/emission. L5 action: answer missing-fields list when it lands (C2b/C3).
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
Merge: squash-merged as 3d2181b (PR #7); reviewed head 5995ee2 unchanged, lane-05
check x2 green, CodeRabbit pass, mergeState CLEAN. Follow-up: none (all review
findings fixed in-branch).

### S2 workspace adoption + shell/navigation (branch muse/lane-05-ui/s2-shell)

Files: presentation.ts amendment (v0.2.0: CSRF_FIELD, TEAM_FIELD, navigation +
shell boundary types, RenderPageFn); ui tsconfig/package.json adoption (extends
base, rootDir .., no member lock), lane-05.yml (root install + workspace test +
owned-import guard), README wiring note; new src/navigation.ts +
test/navigation.test.ts, src/shell.ts + test/shell.test.ts, fixtures extension,
index.ts export wiring.
Workers: W-A navigation (selectDiscoveryCandidates/buildNavigation, 14 tests),
W-B shell (renderPage/pageLocale/pageDirection, 29 tests); coordinator fix:
settings dialog close control + aria-labelledby.
Checks (local, node v24.21.0): workspace `npm test --workspace @canlang/ui`
101/101 pass (48 S1 + 17 navigation + 36 shell, incl. navigation→shell join).
L7 joins requested: presentation.ts into contracts index; packages/ui into
tsconfig.check.json. L6 ack requested: CSRF_FIELD/TEAM_FIELD + ShellRoutes.
PR #10 (muse/lane-05-ui/s2-shell -> main). Self-review: full diff inspected,
worker implementations read end to end; fixed dialog close/aria-labelledby.
Independent read-only review verdict needs-changes: B1 (invalid appDefault
crash), B2 (raw ICU in parameterized captions), B3 (collapse deferral), all
fixed in-branch with regression tests + gap tests (dedup negative,
unavailable-first fallback, non-admitted highlight, unselected teams, empty
sections, meta description, join); nits (entry description doc, highlightPath
doc, CI guard empty-import case) fixed.
Merge: squash-merged as 28f022c (PR #10); reviewed head b89f163 unchanged,
lane-05 check x2 green, CodeRabbit pass, mergeState CLEAN. B1/B2/B3 + nits
fixed in-branch with regression tests (101/101).

### S3 core components + themes + catalog (branch muse/lane-05-ui/s3-components)

Files: presentation.ts v0.3.0 (query seam on PresentationContext, RowView,
ColumnMeta, ListQueryArgs/Result, TextValue, component props, component
catalog types); messages.ts (resolveCaption, formatScalar, canonical tag
helpers); shell.ts (resolveCaption refactor, menu-active fix); new
components.ts + tests (W-A), collections.ts + tests (W-B), catalog.ts +
tests, themes.css + audit tests, index wiring, daisyui 5.7.47 devDep pin.
Workers: W-A core components (29 tests), W-B list/table (35 tests).
Coordinator fixes: shell `active`→`menu-active` (audit-caught, daisyUI v5
renamed it), badge routing by value shape for dotted model-ref columns.
Checks (local, node v24.21.0): 183/183 pass (101 carried + 30 components +
38 collections + 3 catalog + 7 themes + 4 renderer helpers).
L1/L3/L6 ack requested: query-seam decision (factories keep §13 call shape;
dispatcher supplies invocation+query on context; result carries column
metadata). L7: presentation/index + check.json joins still pending.
PR #16 (muse/lane-05-ui/s3-components -> main). Self-review: full diff +
worker implementations read end to end. Independent read-only review verdict
approve-with-nits; all addressed in-branch: N1 collection bounds pinned
(limit 1..100, runner default 25/max 100); N2 scales threaded through
resolveCaption; N3 shared isEnumTypeId predicate; N4 audit hardened (can-*
allowlist, per-theme var completeness, system-override coverage proof);
N5 cell bidi isolation (rowHeading deliberately unisolated, no double-wrap);
N6 catalog arity pins; N7 th scope=col; T1 forbidden-field test, T2 caption
money test, T3 enum: badge test, T4 no-match/validation/conflict/pending
documented as S4/S5 extensions. Literal bidi marks converted to \u escapes.
Merge: squash-merged as f5f2b5e (PR #16); reviewed head 4f7d049 unchanged,
lane-05 check x2 green, CodeRabbit pass; `workspace` red for lane 03's
unsynced miniflare dep (pre-existing on main, not required — five PRs merged
with it red). N1-N8 + gaps fixed in-branch (183/183).

Note (S3): L7's new integration check runs `npm ci`, so the lane-05 daisyUI
devDep required a root-lock sync to merge. Applied mechanically via
`npm install --package-lock-only` (11-line daisyui-only addition, verified
with local `npm ci` + 183/183); the lockfile stays L7-owned and this sync is
flagged for L7 review in the PR. The remaining `integration`/`workspace`
failure is lane 03's unsynced miniflare@4 dep (red on main since #15; lanes
15/17/19/20/13 all merged with it red, so it is not a required gate).
Update on rebase: L7 joined presentation into the contracts index on main;
member TS keeps relative module imports workspace-wide (state/values/identity
precedent), so lane 05 keeps its direct import and the B0-retirement request
is closed. tsconfig.check.json inclusion for packages/ui still pending.

## Remaining work and cleanup

Full lane scope per correction slices C1–C9 below (supersedes S1–S8 as completion criteria; S1–S5 merged stand).

NOTE 2026-10-04: foreign doc/brief/prompt edits (lane-08 steering activity) keep landing in this worktree
uncommitted. They are never lane-05's to commit: set aside in stash `foreign-doc-edits-20261004` plus
/tmp/lane05-steering-backup/ and /tmp/lane05-foreign-conflicts/ (3 files conflicted vs origin/main on pop;
both sides preserved). Owner attention needed; lane-05 commits only owned paths.
Owned resources: this worktree only; no build caches beyond packages/ui/node_modules (owned, disposable).
No producer/docsandbox writes. Cleanup of worktree after final merge + writer/viewer release; never delete
shared caches or unrelated processes. Known risks: L1 catalog-consumption timing (C2 ships contract + witness;
L1 checking/emission is producer-owned), calendar date-picker adapter selection (C7, needs JEV), L7 workerd
runner for B1/B2/B3, daisyUI pin drift (class audit per slice).

## Correction slices C1–C9 (steering plan)

- [x] C1 shell correction (branch muse/lane-05-ui/c1-shell, PR pending): drawer-end right sidebar,
      bottom-right user menu (dropdown-top dropdown-end), user config dialog audit (panel region label,
      focusable toggles), canonical login screen (LoginProps v0.6.0, next sanitization, CSRF). Worker:
      shell.ts + shell.test.ts (53 shell tests). Suite 355/355 green.
- [x] C2 full catalog contract, in two PRs: (a) merged #42 (v0.7.0, 362/362); L1 ACKED (HO-05).
      (b) branch muse/lane-05-ui/c2b-appearance, PR pending — appearance-token matrix on 44/68 words,
      substantiated against pinned daisyUI 5.7.47 CSS (9 tests), alternates on hero/footer/navbar,
      contract v0.8.0. Suite 371/371 green. Props per family land with C3–C8 renderers.
- [x] C3 readable leaves (branch muse/lane-05-ui/c3-leaves, PR pending): contract v0.9.0
      (11 leaf Props), src/appearance.ts closed token renderer, leaves.ts (badge/status/kbd/mockupCode/
      countdown/divider/link) + media.ts (avatar/progress/radialProgress/textRotate), 11 catalog flips.
      Breadcrumbs deferred to C6 (needs descriptor ancestry). Suite 448/448 green.
- [x] C4a field-control factories (branch muse/lane-05-ui/c4a-controls, PR pending): contract
      v0.10.0 (FieldControlKind, FieldControlProps+timeZone, Label/Validator/per-control/Calendar/Filter
      props; control+labelCaption on FormFieldDef), controls.ts 14 factories, shared field-id helpers,
      14 catalog flips. Coordinator closed the timeZone gap (zoned datetime/agenda). Suite 483/483.
- [x] C4b form placement integration (merged PR #62 as f23d1df, reviewed head, green):
      renderExplicitControl dispatch (12 kinds), assertUniqueFieldPaths, multipart on file_input only
      (review: dead file-type branch dropped), renderField reuses label()/validator() fragments
      (byte-identical). Suite 504/504 green.
- [x] C5 groups + slots (merged PR #68 as 9e47bf4, reviewed head, green): contract
      v0.11.0 (32 Props/item/slot types + accordion caption), groups.ts 12 factories + overlays.ts
      14 factories, index exports, 26 catalog flips, arity pins. Review: activation-id guard,
      trigger shapes, accordion labelling, steps note, swap/diff/fab/hover gaps. Suite 623/623.
- [ ] C6 navigation + shared state (branch muse/lane-05-ui/c6-navigation, PR pending):
      contract v0.12.0 (10 Props types), navigation.ts +8 factories (Props moved to contract),
      index exports, 8 catalog flips, arity pins. Coordinator hardening: label guards (7),
      null-binding filter + opens typeof, button inputs via forms serializer, theme-controller
      hook + cancel reset, megamenu group-caption check. Suite 685/685.
- [ ] C7 collections + files + review (branch muse/lane-05-ui/c7-collections, PR pending):
      contract v0.13.0 (7 Props/view types), board + csvImport (collections.ts), fileControl
      (controls.ts), review.ts (new). Props in contract (appearance dims dropped: words admit
      none); index exports; 4 catalog flips; arity pins; review caption guard. Suite 732/732.
      Calendar closed: agenda shipped in C4a; JEV adopts C (no static grid); gallery unwarranted
      (no catalog word; list/board/hover_gallery cover). Evidence: jev/lane-05-c7-20261004/.
- [ ] C8 settings + panels (branch muse/lane-05-ui/c8-settings, PR pending): contract
      v0.14.0 (12 Props types + HistoryEntry re-export), panels.ts (tabs/history/copy),
      settings.ts (renderSettingsPanel), leaves.ts +3 mockups. Props in contract (tabs
      variant dropped; TabsOption replaces ThemeOption misuse); state.js imports retargeted
      to presentation.js (guard); density unknown leaves radios unchecked. 7 catalog flips
      (88/88 implemented, 0 planned); arity pins. Suite 779/779.
- [ ] C9 catalog completion + B1/B2/B3 + discovery evidence (branch muse/lane-05-ui/c9-evidence,
      PR pending): journeys.test.ts (authority/locale/interaction/error/discovery over real code paths
      with hand-emitted fixtures, honestly test-only) + catalog reverse audit + zero-planned pin (88/88).
      Ledger filled 68/68 from catalog data. Suite 796/796.
      B1/B2/B3 join readiness (lane-05 side): UI consumes PageDescriptor/AdmitFn/RenderFn/RowQueryRunner/
      HistoryEntry/DeliveryStatus producer shapes; denied→login without leakage, forbidden-field
      absence, locale fallback, swap preservation, and catalog discovery are proven. Blocked on
      producers (owner-kept): L1 real descriptor emission (syntax merged, no emission yet),
      L7 workerd/D1 runner coordination. No lane-05 mock advertises producer behavior.

## 68-component coverage ledger (2026-10-04; renderer = @canlang/ui factory)

Legend: factory/impl = implemented; (plan) = catalog-planned only; — = absent (C-slice assigned).
Semantic helpers and CSS used inside other renderers do NOT count as selectable components.

| # | Can word | daisyUI | Catalog | Renderer | Props | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | accordion | Accordion | impl | accordion | AccordionProps | C5 |
| 2 | alert | Alert | impl | alert | AlertProps | C5 |
| 3 | aura | Aura | impl | aura | AuraProps | C5 |
| 4 | avatar | Avatar | impl | avatar | AvatarProps | C3 |
| 5 | badge | Badge | impl | badge | BadgeProps | C3 |
| 6 | breadcrumbs | Breadcrumbs | impl | breadcrumbs | BreadcrumbsProps | C3/C6 |
| 7 | button | Button | impl | button | ButtonProps | C6 |
| 8 | calendar | Calendar | impl | calendar | CalendarProps | C4/C7 |
| 9 | card | Card | impl | card | CardProps | — (done S3) |
| 10 | carousel | Carousel | impl | carousel | CarouselProps | C5 |
| 11 | chat_bubble | Chat bubble | impl | chatBubble | ChatBubbleProps | C5 |
| 12 | checkbox | Checkbox | impl | checkbox | CheckboxProps | C4 |
| 13 | collapse | Collapse | impl | collapse | CollapseProps | C5 |
| 14 | countdown | Countdown | impl | countdown | CountdownProps | C3 |
| 15 | diff | Diff | impl | diff | DiffProps | C5 |
| 16 | divider | Divider | impl | divider | DividerProps | C3 |
| 17 | dock | Dock | impl | dock | DockProps | C6 |
| 18 | drawer | Drawer | impl | drawer | DrawerProps | C5 |
| 19 | dropdown | Dropdown | impl | dropdown | DropdownProps | C5 |
| 20 | fab | FAB/Speed Dial | impl | fab | FabProps | C5 |
| 21 | fieldset | Fieldset | impl | fieldset | FieldsetProps | C5 |
| 22 | file_input | File Input | impl | fileInput | FileInputProps | C4 |
| 23 | filter | Filter | impl | filter | FilterProps | C4 |
| 24 | footer | Footer | impl | footer | FooterProps | C5 |
| 25 | hero | Hero | impl | hero | HeroProps | C5 |
| 26 | hover_3d | Hover 3D Card | impl | hover3d | Hover3dProps | C5 |
| 27 | hover_gallery | Hover Gallery | impl | hoverGallery | HoverGalleryProps | C5 |
| 28 | indicator | Indicator | impl | indicator | IndicatorProps | C5 |
| 29 | input | Text Input | impl | input | InputProps | C4 |
| 30 | join | Join | impl | join | JoinProps | C5 |
| 31 | kbd | Kbd | impl | kbd | KbdProps | C3 |
| 32 | label | Label | impl | label | LabelProps | C4 |
| 33 | link | Link | impl | link | LinkProps | C3 |
| 34 | list | List | impl | list | ListProps | — (done S3/S5) |
| 35 | loading | Loading | impl | renderState | SharedStateProps | — (done S3) |
| 36 | mask | Mask | impl | mask | MaskProps | C5 |
| 37 | megamenu | Megamenu | impl | megamenu | MegamenuProps | C6 |
| 38 | menu | Menu | impl | menu | MenuProps | C6 |
| 39 | mockup_browser | Browser mockup | impl | mockupBrowser | MockupBrowserProps | C8 |
| 40 | mockup_code | Code mockup | impl | mockupCode | MockupCodeProps | C3 |
| 41 | mockup_phone | Phone mockup | impl | mockupPhone | MockupPhoneProps | C8 |
| 42 | mockup_window | Window mockup | impl | mockupWindow | MockupWindowProps | C8 |
| 43 | modal | Modal | impl | modal | ModalProps | C5 |
| 44 | navbar | Navbar | impl | navbar | NavbarProps | C6 |
| 45 | otp | OTP | impl | otp | OtpProps | C4 |
| 46 | pagination | Pagination | impl | pagination | PaginationProps | C6 |
| 47 | progress | Progress | impl | progress | ProgressProps | C3 |
| 48 | radial_progress | Radial progress | impl | radialProgress | RadialProgressProps | C3 |
| 49 | radio | Radio | impl | radio | RadioProps | C4 |
| 50 | range | Range slider | impl | range | RangeProps | C4 |
| 51 | rating | Rating | impl | rating | RatingProps | C4 |
| 52 | select | Select | impl | select | SelectProps | C4 |
| 53 | skeleton | Skeleton | impl | renderState | SharedStateProps | — (done S3) |
| 54 | stack | Stack | impl | stack | StackProps | C5 |
| 55 | stat | Stat | impl | stat | StatProps | C5 |
| 56 | status | Status | impl | status | StatusProps | C3 |
| 57 | steps | Steps | impl | steps | StepsProps | C5 |
| 58 | swap | Swap | impl | swap | SwapProps | C5 |
| 59 | tabs | Tabs | impl | tabs | TabsProps | C8 |
| 60 | table | Table | impl | table | TableProps | — (done S3/S5) |
| 61 | text_rotate | Text Rotate | impl | textRotate | TextRotateProps | C3 |
| 62 | textarea | Textarea | impl | textarea | TextareaProps | C4 |
| 63 | theme_controller | Theme Controller | impl | themeController | ThemeControllerProps | C6 |
| 64 | timeline | Timeline | impl | timeline | TimelineProps | C5 |
| 65 | toast | Toast | impl | toast | ToastProps | C5 |
| 66 | toggle | Toggle | impl | toggle | ToggleProps | C4 |
| 67 | tooltip | Tooltip | impl | tooltip | TooltipProps | C5 |
| 68 | validator | Validator | impl | validator | ValidatorProps | C4 |

Non-catalog semantic constructs (kept, owned behavior): page (renderPage, done S2; C1 corrects),
form/edit/delete/action/actions (done S4), title/text/content (done S3), navigation (done S2),
copy/history/board/gallery (planned; C7/C8), export/print links (done S5), settings panels (C8),
review/csv-import (C7), htmx/collections controls (done S5).
