# W01.2 — Pure leaf graph choice and single-writer assignment

Task: W01.2 (lane `work-contracts`, wave 1, after `C01.ready`; retry —
prior native contained, no state taken from it). Produced
2026-10-06T09:43:39Z by lane F session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9.
Planning record only; no implementation authorized.

- Head verified: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06`
- Companion: `files.json` (pure-leaf file graph + writer assignment +
  C04 requests).

## Source graph evidence (all verified by import inspection at head)

- `@canlang/work` has **no build script, no exports, no dependencies**
  (typecheck + source-only tests). It cannot be imported as a built
  package; every consumer uses source, injection, or dynamic loading.
- `work -> state`: exactly **one type-only edge** —
  `work/src/kernel/commands.ts` imports `SystemCommandDef`/
  `SystemCommandContext` types from `state/src/ports/system.ts`. No
  runtime edge. (Note: the filetree ownership note claiming runtime
  state-port calls from work does not match this import evidence;
  treat that claim as unverified, not as fact.)
- `state -> work`: **zero static edges**. The two work-loaders
  (`fanout/work-loader.ts`, `receipt/work-loader.ts`) import work
  modules dynamically by file URL for byte-parity checks only, and
  `fanout/tables.ts` documents that it never imports work sources.
- `cloudflare -> work`: **zero static edges**. `runtime/invoke.ts`
  documents that work helpers "arrive INJECTED — `@canlang/work` has
  no dist build"; `activate.ts` receives gates by producer join.
- Shared edges: all three packages statically import only
  `contracts/` (relative `../../../contracts/src/*.js`, types and
  small value constants). The contracts-only type graph is already
  the de-facto shared vocabulary.

Consequence: any `state -> full work` static dependency would route
through `commands.ts`, the sole file carrying the work->state
(type-only) edge — an avoidable layering/build cycle, exactly as the
plan states.

## Fair comparison

**Option A — contracts-only `work-kernel` leaf** (plan's direction):
new `packages/work-kernel/` depending on contracts types only;
state/stdlib/cloudflare/testkit consume the leaf, never full work.
Enforcement: the explicit package DAG makes violations structurally
visible (a `state -> work` import fails review; the leaf's manifest
forbids state/commands/crypto imports). Costs: new package
(manifests, tsconfig, build), vendor entry, release-stamp proof
(`0.1.0`, not exempt — `release/stamp.ts` exempts only full
work/files/services at `0.0.0`), binary delivery via C04 typed
inventory, packaged-install test outside the checkout.

**Option B — isolated `@canlang/work/transitions` subpath**: same
mechanisms under the existing package with an enforced subpath
boundary. Fewer packages and no new package identity. Costs: still
needs new builds, vendors, and releases for the subpath, plus
continuous policing of build roots, exclusion of `commands.ts`
(the state-edge carrier), exclusion of Node test loaders and Node
crypto from the Worker export, and proof that no full-work runtime
leaks across the subpath boundary. Enforcement is by convention and
review, not by the manifest graph.

**Root JEV advice** (three consultations favored the leaf, per the
plan) is preserved **as advice**, not as decision. The source
evidence above independently supports the leaf: the enforceable DAG
removes the policing burden that Option B retains, and both options
pay the build/vendor/release costs anyway. Recommendation: Option A.
Final choice belongs to the work owner + coordinator at W02.1.

## Single-writer assignment

- **Work integrator** (one person/lane): serializes package-local
  manifests, Cargo/module registrations, public wrapper joins,
  `state/src/ports/transact.ts`, and `cloudflare/src/runtime/
  invoke.ts`; owns the exact file list in `files.json`; queues
  module patches from rows/policy/receipts lanes; never edits a
  branch-owned implementation after handoff.
- Branch lanes own only their assigned `src/*.ts`, `decisions/*.rs`,
  and conformance files (see `files.json`); host shells stay with
  `work-host`; C04 exclusively owns bundle/local-run/testkit
  propagation, root build/lock, and the shared manifest graph.
- `W06.runtimehandoff` releases `runtime/invoke.ts` to validation;
  after handoff work never writes that file again (W06.3 depends on
  validation V09.1 so final runtime tests cannot race edits).

## C04 requests (submitted, not executed)

1. Root build/lock: add work-kernel to workspace build order
   (contracts → work-kernel → state/stdlib/cloudflare/testkit) with
   type-resolution checks; no unpublished-private-workspace consumer
   may ship to published consumers.
2. Binary delivery: `vendor/work-kernel` producer inventory entry,
   exact new bare-import rewrites, Wasm bytes through typed
   inventory (never current UTF-8 JS writing), manifest
   discovery/integrity for the selected kernel root/binary, and
   `release:stamp` proof against a correctly built isolated tree.
3. Exclusions preserved: `vendor/state/fanout/work-loader.js` and
   `receipt/work-loader.js` stay out of the bundle.

## Owner review status

Required (recorded, not assumed): work owner (graph choice + leaf
scope), state owner (transact/registry consumption), cloudflare
owner (runtime invoke + producer seam), C04 delivery owner (the
three requests above). W02.1 must not start until this choice is
approved.
