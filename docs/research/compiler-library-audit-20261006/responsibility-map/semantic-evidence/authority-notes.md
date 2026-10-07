# Step8 authority/effects and graph evidence

Planning/source audit only. `authority.json` pins each inspected full source file at live HEAD and at source ref `1fd07722090fe70228a6b661e3c6e136275ca84b`, gives finite function ranges, independently authored DESIGN contracts, accepted/rejected cases, stage consumers, and test witnesses. Initial HEAD is `1db4516c645799ff3c2d7287ebd6d470ecd5896c`. No production, tests, manifests, package sources or commits were changed. This lane did not execute tests or source probes; root owns probe execution and joined results. Source review is narrower than end-to-end runtime qualification.

## Principal candidate: recurring scope dependency closure

`effects.rs::check_every_scopes` (4052–4102) walks `scenario_models` and statement `scenario_calls`; a CRUD target becomes its model. Direct models originate in `collect_subtree_models` (5059–5142) visiting creates, record writes, bare model refs and query domains. `walk_scenario` collects only its own subtree (2387–2390), and `walk_effect` adds call edges only for statement calls (3055–3059). Derive expression calls and omitted creation-field initializer expressions outside that subtree do not contribute upstream models. `walk_derive` builds emission data but does not populate this scope graph.

Independent expected outcome: DESIGN line526 requires scope inference from owner-bound query/write/local-call dependencies and rejection of mixed app/team families. Line314 says derives inherit the caller's evaluation mode. A team query plus a called pure derive querying an app model should therefore be diagnosed at `every(5m)` with E4051. Replacing the derive call with its body is a paired control with the same semantic query outcomes. The scoped runtime operation must remain separately qualified; a missed diagnostic alone is not a demonstrated permission bypass.

Root probe vector, derive form:

```can
# Recurring derive dependency witness.
app Scope
Given
 AppConfig in app { n:int }
 Todo { title:text }
 policy AppConfig read=members
 derive app_count():int = count(AppConfig)
When
 scenario tick on=every(5m)
  do
   let team_count=count(Todo)
   let app_total=app_count()
Then
```

Control: replace `app_count()` in the scenario body with `count(AppConfig)`; same E4051 target. A single-family variant removes `team_count` and should remain E4051-clean. Existing `transitive_handler_scope` (effects test855) establishes statement-call transitivity, and `write_only_handler_scope` (881) establishes a model obtained through call result/write. These tests are independent existing witnesses, not newly executed verification.

Root default vector: replace Todo with `Todo { n:int=count(AppConfig) }`, remove the derive, and make tick's body `create Todo {} as made`. A server variant spells `n:int server=count(AppConfig)`. Creation reads use the same authority and fence (DESIGN133), and the mixed query/write outcome suggests E4051. Whether §6 scope inference explicitly includes omitted initializer reads remains a bounded design interpretation; retain candidate status until root confirms source acceptance and normative expectation. Do not classify a source parser/type rejection as the scope miss.

## Authority stages and disclosure limits

The effect pass records gates, checked typed expressions, owner IDs, exact selectors, triggers, guards and effect order. The type pass owns read purity, input/result shapes, actor narrowing, trusted-call rejection, send/schedule validation and server-default placement. Resolve owns names/import ownership and containment. None independently establishes actual operation admission or filtered runtime serialization.

`check_secret_return` only inspects scalar or nullable scalar secret. Structural secret/owner/File propagation findings have already been demonstrated in Step7 and must not be counted as new findings here. DESIGN368's broader authority-derived scalar dependency promise is not established by the reviewed effect functions; this is a stage/coverage question for the emission/runtime lane, not a new demonstrated exploit. Policy field presence is similarly distinct from successful read authorization. Guard interpolation confidentiality and arbitrary catalog impurity transitivity are not end-to-end qualified in this lane.

`ScenarioData.scope_authority` is checked source metadata. IR `decode_scenario` lines4241–4250 explicitly emits E6008 for this boundary because no §13 emission exists. This prevents claiming source `scope=authority` checking implements privileged-report execution. JS read metadata and the canonical Cloudflare invocation seam are real consumers for supported cases; the inspected runtime file distinguishes generated canonical descriptors from old/direct handler execution seams. A clean source check cannot establish identical runtime authority on every serving path.

Fixtures are typed stored snapshots, not production client creates. Their server-field initialization and inspection context cannot be interpreted as caller mutation authority (DESIGN403/407). Resolver fixture edge vectors become examples `FixtureRecipe.seeds` (examples434–460) and must preserve order and dedup semantics if graph mechanisms change. Migration effect checks are deliberately switched off in `walk_migration` (3743–3800); `migrate_check::check_migration` checks predecessor/directive consistency, while old-schema collisions and activation admission are runtime `validateTransition` responsibilities. No generic cycle checker can supply those runtime guarantees.

## Graph policy and joining

Retain the existing Pass9 graph packet as the normative evidence for current graph origins, upstream chains, cycle witnesses and multiplicity. Its `ASSESSMENT.md` distinguishes: composition return-to-origin; containment all origins reaching a repeated parent including upstream; fixtures/derives return-to-origin; static calls legacy path witnesses globally deduped by vertex sets. The source graph review here confirms those owners remain different mechanisms. Ownership links stay installed on invalid cycles; effect `scope_is_app` protects itself with a visited set and returns false on repeat. This is finite termination on an already invalid program, not a new accepted owner assignment.

No new graph diagnostic policy, shared-library replacement, JEV transmission or previously rejected payload retry was selected. Pass9's existing nondeterministic E3005 content/span finding remains existing evidence. `analysis/check.rs::dedup_diagnostics` compares `(file,start,end,code,message)`; two distinct messages sharing code/span survive. Sorting by `(file,start,code)` cannot stabilize graph messages or closing-edge spans selected upstream. Root probes and ledger must join by full evidence identity rather than just code/span.

The source ref/live pins are full-file hashes; callers/ranges are live coordinates. This packet does not claim source changes were qualified merely because a prior prebuilt rlib ran. Root should associate its exact compiler build pins and raw findings with these candidate vectors before classifying them as demonstrated defects.
