# B4-G: non-hook `c.actor`/`c.now` + `team`/`operation` bindings — evidence + options

Read-only packet (coordinator file directive 2026-10-06T08:54Z). No checker
edits. Cargo verdicts deferred to a later grant.

## 1. Source spelling vs runtime spelling

`.can` authors write bare names (`actor`, `team`, `now`, `operation`).
Codegen roots the emittable two under the ambient context parameter:

- non-hook: `actor` → `c.actor`, `now` → `c.now`
  (`compiler/src/codegen/ir.rs:2418-2419`)
- pre-commit hook: `actor` → `$hookCtx.actor`, `now` → `$hookCtx.now`
  (`ir.rs:2416-2417`; run binds `($candidate,$hookCtx)` at
  `compiler/src/codegen/js.rs:5263`)

`team` and `operation` have **no lowering arm**: they fall through to the
bare-name fallback `IrExpr::Name` (`ir.rs:2479`), i.e. free variables in the
emitted JS. No `js.rs` site binds them; no test pins their emission.

## 2. Resolver evidence: which scopes bind what

`with_facts(parent, actor, team, operation)` (`resolve.rs:2434-2458`).
`now` is unconditional (line 2450); `actor` is always present with a kind.

| Scope site | actor kind | team | operation |
|---|---|---|---|
| Model creation initializers (2873/2880) | NonNull | yes | yes |
| Contract/Event fields (2890) | NonNull | yes | yes |
| Invariant (2913) | Nullable | yes | yes |
| Derive fn body (3027) / derive field (3062) | Nullable | yes | yes |
| Param defaults (3121) | Nullable | **no** | yes |
| Fixture (3166) | NonNull | yes | **no** |
| Capability event fields (3282) | NonNull | yes | yes |
| Policy/Unique/Lock/Retain rules (3323) | Nullable | yes | yes |
| CRUD `when=` (3870) | Nullable | yes | yes |
| CRUD `by=` (3878) / scenario `by=` (3951) | Nullable | **no** | yes |
| Trusted (`on=`) scenario incl. hooks (3937) | **Null** | yes | yes (+`event`) |
| Untrusted scenario body (3970) | NonNull iff `by=` proves auth, else Nullable | yes | yes |
| Example headers (4010) | NonNull | yes | **no** |
| Page (4487) | Nullable | yes | yes (+`preferences`) |

Trusted = carries `on=` (`index_scenario`, resolve.rs:1773). So every hook,
timer, committed-event and capability-completion handler typechecks with a
provably-null actor; untrusted bodies narrow via `by=` prove-auth
(`auth_proves_actor`, types.rs:3491) or null-guards (T02 B2 witnesses).

Authored bindings cannot hide an active fact: `E2012`
(`param_hides_contextual`, resolve.rs:3087; lint mirror
`is_contextual_fact`, lint/rules.rs:445; explain.rs:457).

## 3. Types evidence

- `team: Team` → `id:text`, `timezone` (types.rs:10190, 10411-10418)
- `now: datetime` (types.rs:10191); fixed at admission across retries (DESIGN:173)
- `operation: OperationContext` → read-only `id:text`, `source:text`
  (types.rs:10192, 10419-10425)
- `actor: user?`; `user.email`/`email_verified` readable **only** off the
  actor root (types.rs:10377-10396); `retain until=` bans
  actor/now/operation but **allows** team (types.rs:5176)
- `server=actor` needs an authenticated creator; a trusted null actor is
  rejected at runtime per DESIGN §2 (resolve.rs:240-243, types.rs:1258-1270)
- `server=actor`/`server=now` lower to `"actor"`/`"now"` string sentinels
  for the runtime to fill (js.rs:2345-2346)

DESIGN:173 contract: fixed context `actor:user?`, `team:Team` "when
applicable", `now:datetime`, `operation:OperationContext`; trusted handlers
have `actor=null` and team "derived from the verified occurrence, never an
arbitrary payload grant".

## 4. Emitter evidence: what `c` is bound in

Every non-hook emission binds `c` as the first parameter, so `c.actor` /
`c.now` are always bound there:

- scenarios: `async handler(c,{params})` / trusted `async handler(c,{event})`
  (js.rs:5323-5331)
- rules: `(c,row)` (js.rs:5083-5085); derives: `async name(c,row)`
  (js.rs:5206, 5462); pages: `(c,bindings)` (js.rs:3126); CRUD ops:
  `c,...` (js.rs:5379+)

Hooks never receive `c`: ambient-context expressions (`equalValue(c,...)`,
structural/decimal equality) are `E6008` in hooks (js.rs:1199, 1241-1247,
1804, 1830). Non-hook `on=` handlers (timers, committed events,
capability completions) currently keep `E6008` "handler triggers have no
§13 member lowering" — only pre-commit hooks lower (ir.rs:4170-4188). Their
`c.*`/`team`/`operation` bindings are therefore check-time-only today.

## 5. The gap (load-bearing, not hypothetical)

`team` / `operation` resolve + typecheck in emittable bodies but emit as
unbound free variables. Real draft corpus depends on both:

- `source=operation.id` in scenario bodies: CanPurchase.can:132,143,311;
  CanLeave.can:130,131; CanChat.can:77
- `active_member(person,team)` in derive bodies: CanChat.can:15;
  CanGallery.can:15,38; CanDo.can:39 (invariant)
- `team.id` in an examples event header: CanChat.can:150

Hook bodies share the gap (`$hookCtx` carries only actor/now/trigger
state): a hook reading `team`/`operation` also emits a free variable.

## 6. Options (no edits made; decision is the coordinator's)

- **O1 — status quo + runtime globals (not recommended).** Leave emission
  as-is; lane C provides ambient `team`/`operation` globals. Breaks the
  explicit-`c` threading every other binding uses; untestable at check
  time; hook/non-hook values would diverge silently.
- **O2 — thread through `c` (recommended).** Add `team` → `c.team` and
  `operation` → `c.operation` lowering arms (mirroring `c.actor`/`c.now`),
  with the runtime populating `c.team`/`c.operation` per DESIGN:173
  (trusted: team from the verified occurrence). Needs a lane-C serve-time
  contract for both fields; hook side needs the T34-plan Q5 hook-bounds
  ruling (extend `$hookCtx` vs reject). Small, follows the existing
  pattern; corpus uses above go green by construction.
- **O3 — fail closed with `E6008`.** Reject `team`/`operation` in
  emittable bodies until the runtime contract lands (precedent: handler
  triggers, ir.rs:4177-4187). Honest but red on real corpus
  (CanPurchase/CanLeave/CanChat/CanGallery/CanDo), so it blocks
  integration until O2 or a corpus rewrite.
- **O4 — narrow the resolver (not recommended).** Drop `operation`
  (and/or `team`) from scenario-body `with_facts`. Contradicts
  DESIGN:173 fixed context + `E2012` expectations; largest churn;
  moves the failure to check time without defining the serve-time
  value.

Suggested sequencing: coordinator takes O2 (possibly with O3 as the
interim tripwire under a later grant); lane C contracts `c.team` /
`c.operation` population incl. trusted-handler derivation; T34-plan Q5
settles `$hookCtx` team/operation; lane A implements + pins with
`b4g_` codegen tests under a cargo grant. If O2-vs-O3 becomes a
contested design decision at implementation time, run the AGENTS.md JEV
triple before committing.

## 7. Open producer questions (routed, not answered here)

1. (lane C) What populates serve-time `c.team`/`c.operation` for user
   operations, and what is `c.team` when no team is in context?
2. (lane C) Trusted-handler derivation of team "from the verified
   occurrence" — which occurrence fields, and what happens when absent?
3. (T34-plan Q5) Do hooks get team/operation via `$hookCtx`, or are they
   out of hook bounds (→ `E6008`)?
4. (lane B / B7-model) Does the missing-policy intent change what
   `c.actor=null` bodies may read? (No evidence either way in scope.)
