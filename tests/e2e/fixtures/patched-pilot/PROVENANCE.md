# Patched-pilot provenance (suite-3, lane G)

Live-run fixtures for the T37 basic pilot: exact-site patches over the
pristine draft at submodule pin `40656da`, covering the 3 adjudicated
sites ONLY. The authoritative draft stays pristine (no submodule
writes); these copies exist so the pilot can compile and run while the
owning lanes prepare the real restructures.

## Base pin

- Draft submodule: `40656da211a410cb6fb363a9c2afc3010fcb8b29`
- Pristine bytes (sha256, verified against the G-SUITE2-01 check envelope):
  - `draft/CanDo.can`: `15761cc422c6d11827a6f13aa3cc3318a8bb393ef2110169f1a02ff046e4ec35`
  - `draft/shared/Locations.can`: `6cafeb02349c80c8ff19a278bc9072258fe8b8f402409629fed534854e106c7a`
  - `draft/shared/Employees.can`: `64b941f4e3db0afe499903642585e362482d6aa39f679b3b1e688dc912d3b7f4`
- Patched bytes (sha256):
  - `CanDo.can`: `ac68cddbc301c030fe13d501f9e2477d941cdeb1a330a8f7d967020a0ab93b04`
  - `Locations.can`: `6cafeb02349c80c8ff19a278bc9072258fe8b8f402409629fed534854e106c7a` (identical)
  - `Employees.can`: `d809808aadfbd43a65bb591e7c58d406a9d41379e6a221359e42b65cd3a2f6dd`

## The 3-site diff (complete)

```diff
--- draft/CanDo.can
+++ tests/e2e/fixtures/patched-pilot/CanDo.can
@@ -41,7 +41,7 @@
-  invariant preferences: row.location==null or can_work(actor,row.location)
+  invariant preferences: actor==null or (row.location==null or can_work(actor,row.location))
--- draft/shared/Employees.can
+++ tests/e2e/fixtures/patched-pilot/Employees.can
@@ -5,8 +5,8 @@
-  export derive staff(person:user):bool = any(Employee as e,e.user==person and e.active and active_member(person,team))
-  export derive can_work(person:user,location:Location):bool = any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))
+  export derive staff(person:user):bool = any(Employee as e,e.user==person and e.active)
+  export derive can_work(person:user,location:Location):bool = any(Employee as e,e.user==person and e.active and (e.operator_wide or e.home==location or location in e.locations))
```

`Locations.can` is byte-identical (no adjudicated site). No `##`
markers or any other line differs: the exclusivity test in
`challenge-pilot-patched.spec.ts` re-proves this on every run (pristine
pin guard + per-file hunk bounds), failing loud on drift.

## Verdict cites

- T02 adjudication: lane A `067fba0` -> main `cf36983`
  ("B1 completion-envelope fix + B2/B3 intended-rejection witnesses").
- B2 (CanDo:44, E3001 nullable actor): `t02_preferences_invariant_nullable_actor_rejected`
  (witness) + `t02_preferences_invariant_guarded_actor_accepted`
  (opposing case: `invariant preferences: actor==null or needs(actor)`,
  null-guard narrows). The patch applies the blessed guard-first shape.
- B3 (Employees:8,9, E3010 derive purity): `t02_derive_state_read_builtin_rejected`
  (witness: `active_member` is a catalog state-read builtin, banned from
  derives per DESIGN:137) + `t02_derive_pure_accepted` (opposing case:
  pure derive stays clean). The patch removes the state-read conjunct.
- B4-G context bindings: lane A `0f21821`, O2 ruled (thread
  `c.team`/`c.operation`), implementation pending at `fa5c8e3`.

## Semantic notes (read before citing pilot results)

- Site CanDo:44: anonymous callers (`actor==null`) now satisfy the
  preferences invariant vacuously. Same philosophy as the B2 opposing
  case; the pilot never exercises anonymous preferences.
- Sites Employees:8,9: the dropped `active_member(person,team)`
  conjunct removes the live-membership dimension — `staff`/`can_work`
  now answer from the seeded `Employee` rows alone (active row present
  or not). Pilot-coherent: the pilot varies ROW presence (seeded staff
  vs rowless outsider), never live team membership, so every gate leg
  keeps its discriminating power. The owning lanes' real restructure
  may restore the membership dimension differently.
- NOT patched (out of the 3-site scope, suite-3 verify observes):
  CanDo:39 invariant + CanDo:91 handler still call
  `active_member(x,team)` (B6 external-unimplemented E6007 risk at
  emit; `team` unbound at runtime until B4-O2 lands).
