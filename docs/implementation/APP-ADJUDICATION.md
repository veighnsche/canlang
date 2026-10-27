# FP.APP-ADJUDICATION — per-app inclusion record (first edition)

Date: 28 October 2026. Source: branch `goal/production-ready` (= `origin/main`
`e5af510f` + docs/B25), draft pin `5749c75b`, release compiler built from that
source, rebuilt native catalog `ca50fdca…`.

Method: each non-original24 app compiled with `--native-scenario-receipts` over
a provider closure (app file + all shared files + direct `uses=[]` member apps
+ direct `use` package providers, plus E2005-driven iteration, max 4 rounds).
Verdicts use OWN-FILE diagnostics only; dependency-file diagnostics are closure
artifacts, not app verdicts. Raw per-app JSON: scratch `/tmp/goal-adjud/`
(not retained). The 21 original24 apps plus CanTable are the supported corpus.

Legend — INTENDED: unsuitable for inclusion by policy or by a missing
capability lane (needs generation/BGI, needs business-policy decision).
DEFECT: unsuitable because of a bug (draft source, compiler, compositional).
Routes: DRAFT = draft coordinator owns corrections; B-LANE = compiler backlog;
BGI = generation lane; OWNER = business-policy owner decision required.

| App | Own-file result | Verdict | Route |
| --- | --- | --- | --- |
| CanTable | clean, 33 ops | SUPPORTED | — |
| CanDo | original24+app: 2 E6008 source-requirement (sibling-constructor loop, query closure) | DEFECT compiler gaps | B-LANE |
| CanLoyalty | original24+app: 3 E6008 (first-query correspondence ×2, source-requirement) | DEFECT compiler gaps | B-LANE |
| CanVolunteer | original24+app: 12 E6008 (hook derive, source-requirements, send guard) | DEFECT compiler gaps | B-LANE |
| CanChat | 1 E6008 saved-styles scope check | INTENDED (generation styles) + BGI/compiler joint | BGI |
| CanWorkbench | 1 E6008 unbound inline style unit | INTENDED (needs generation binding) | BGI |
| CanOnboard | 1 E6008 source-requirement receipt (progress-decimal fixed) | DEFECT compiler gap | B-LANE |
| CanCreative | 4 E6008 dispatch correspondence, creative.generate call | DEFECT compiler/AI gap | B-LANE |
| CanPromptLab | own clean; 16 E6008 hook-query in Locations.can | DEFECT compositional lowering gap | B-LANE |
| CanApprove | 3 E6008 unbound style units + 2 E2013 member | INTENDED (generation) + DEFECT draft | BGI + DRAFT |
| CanBoard | 5 E6008 unbound trait units + 33 E2013 + 10 E5002 | INTENDED (generation) + DEFECT draft | BGI + DRAFT |
| CanDecide | 3 E2001 unresolved + 1 E6008 unbound style | INTENDED (generation) + DEFECT draft | BGI + DRAFT |
| CanEnrich | 2 E2001 + 1 E6008 unbound style + 1 E2013 | INTENDED (generation) + DEFECT draft | BGI + DRAFT |
| CanFeedback | 1 E6008 unbound trait + E3015/E5001/E5006/E3001 | INTENDED (generation) + DEFECT draft | BGI + DRAFT |
| CanTrade | 1 E6008 unbound trait + E3002/E3015 enum/field | INTENDED (generation) + DEFECT draft | BGI + DRAFT |
| CanCatch | E2001/E3010/E3001 opaque + 1 E6008 | DEFECT draft (+1 compiler triage) | DRAFT + B-LANE |
| CanCheck | E3011/E2001/E3001/E3002 + 1 E6008 | DEFECT draft (+1 compiler triage) | DRAFT + B-LANE |
| CanDiscover | E3003/E2001/E3001/E3002 + 1 E6008 | DEFECT draft (+1 compiler triage) | DRAFT + B-LANE |
| CanGallery | E3002/E3001 enum + 3 E6008 | DEFECT draft (+3 compiler triage) | DRAFT + B-LANE |
| CanHire | E3002/E3001/E3003/E2001 + 3 E6008 | DEFECT draft (+3 compiler triage) | DRAFT + B-LANE |
| CanStats | E2001/E3010/E3001/E3003 + 1 E6008 | DEFECT draft (+1 compiler triage) | DRAFT + B-LANE |
| CanSync | E2001/E3003/E3001/E2013 + 1 E6008 | DEFECT draft (+1 compiler triage) | DRAFT + B-LANE |
| CanGrant | 6 E3001/E3010 example/expected values | DEFECT draft | DRAFT |
| CanInbox | 40 E2001/E3010/E3001/E2013/E3003 | DEFECT draft | DRAFT |
| CanKnowledge | 44 E2001/E2013/E3015/E3001/E3010/E3003 | DEFECT draft | DRAFT |
| CanLearn | 11 E2013/E3003/E3010/E3001/E3002 | DEFECT draft | DRAFT |
| CanMail | 24 E3003/E3001 narrowing/user mismatch | DEFECT draft | DRAFT |
| CanReception | 7 E3003/E3002/E3001 enum narrowing | DEFECT draft (E3002 enum-enum to B-LANE triage) | DRAFT + B-LANE |
| CanTime | 8 E3001/E2013 | DEFECT draft | DRAFT |

Notes:

- E2013/E3001 "unknown member" inside a 4-file closure usually means the draft
  references a provider member outside the closure or a genuinely missing
  declaration; both are draft-coordinator-owned (source + composition).
- E3002 enum-vs-enum comparison refusals (CanReception, CanGallery, CanTrade,
  CanHire) are suspicious as language gaps; routed to B-LANE triage, not
  assumed draft bugs.
- "No saved unit is bound" / E5xxx / saved-styles scope failures are
  generation-boundary outcomes: the app needs BGI-bound trait/style units.
  INTENDED exclusion until the BGI lane binds them; not compiler defects.
- CanPromptLab exposes a real compositional gap: its clean file plus shared
  files yields hook-query E6008s blamed on Locations.can, which is clean in
  the original24 composition. B-LANE triage.
- Recorded business-policy ambiguities still needing OWNER verdicts (from the
  finished-product findings): Mail/Reception/Rent/Discover/Catch/Affiliate/
  Event/Stock countercases, Volunteer historical-vs-current recipients +
  stale-consent invalidation, Partner authorized lock edit. No new business
  policy is chosen here.
- No draft file was corrected for this record. One compiler gap found by
  triage is fixed on this branch: linear `progress` accepts decimal values
  like `radial_progress` (CanOnboard's percentage bar; 4 factory tests).
  CanOnboard's remaining diagnostic is a real unimplemented lowering
  (bounded copy-create loop with computed fields across parents in
  `bounded_sibling_create_loop`): B-LANE design, not a small fix. Other
  corrections belong to the routed owners.
