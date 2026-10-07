# Independent SEQ-009 before-repair invocation review

**Accepted as valid before-repair evidence with partial positive qualification. SEQ-009 and parent F1 remain open.** The frozen packet genuinely consumes unchanged compiler artifacts through production `assembleModules`, `buildInvoker`, admission and mutation pipeline, with production `createD1Storage` on persisted local Miniflare D1. The retained nullable failures and import-surface failures are real observations. Passing a reviewer control that expects those failures does not satisfy the failed product requirements.

The reviewed packet is pinned to source `db57c3794d386fcd27f17f54b199272d58106a81`, draft `a55a0f700f07f6f972d9d6091b0fdbceee399eb9`. Frozen `REPORT.md` SHA-256 is `c67f47e2fea99731b78b13d615022356a2ed1ff0b4aa96fcf2f179c19331d180`; `pins.json` is `000dbae0d3a89b08aac7be70364c0f3fe3257ad7f5e9464acd29e98349505784`. Independent verification matched all 3,383 invocation file pins, every recorded workspace link target, and 1,636 nested metadata source/output/support/probe/compiler hashes. The separate `Bounded`, `MemberControl` and `NumericControl` artifacts reproduced byte-for-byte with the pinned real Rust CLI and catalog; all three compilations exited zero.

## Independent execution and receipt review

After root/author freeze, a private reviewer control consumed the unchanged actual Bounded artifact. It assembled the real emitted module against the existing Cloudflare runtime stdlib peer, created an anonymous identity with the real resolver backed by the memory test store, and invoked the production canonical route on a fresh real Miniflare D1 database. Ten independent observations verified:

- Omitted `Job.account` rejects after null-fill, persists one rejection receipt, and exact retry returns that stable rejection without effects.
- Explicit `account:null` rejects during admission with no receipt or SQL change.
- A supplied current Account reference creates a Job with exactly the observed scalar and machine defaults: title `"test"`, count `"1"` as a string, enabled `true`, status `"idle"`.
- The actual emitted `advance` executes `idle -> queued -> ready`, produces one net version increment to 2, and records two ordered history entries at version 2.
- Actual anonymous public read returns one exact known Job id/version/data projection and leaves every SQL table unchanged. A fresh stale-reference operation returns conflict without writes.
- Miniflare dispose/reopen with the same private persistence directory retains all records/history/receipts/outbox/schedules/fence/fence-log and revision. A recreated invoker replays the saved transition receipt without effects.

The initial sandbox attempt failed because Miniflare could not listen on loopback (`EPERM 127.0.0.1`). The narrowly escalated repeat completed. This infrastructure refusal is distinct from the product observations. Raw independent observations and compiler commands/hashes are embedded in `f1-invocation-review.json`; private reviewer harness and persistence paths are recorded there. No full rebuild or author mutation rerun was needed.

I also independently inspected the frozen raw author receipts rather than accepting its predicates alone. The final mutation packet has 35 vectors and 42 predicates, with 38 true and four nullable/dependent expectations false. One predicate only captures historical-replay authorization posture; this count does not mean 38 comprehensive feature gates. Raw checks confirm supported creation/update/replay, descriptor-owned wrong-model and missing/version/stale refusal, owner/member/anonymous denial, current membership revocation, actual late failure after transition staging, domain rollback plus rejected receipt persistence, and saved success/error replay before and after D1 restart. Identity is the actual resolver/live membership reader over a **memory test store**, while domain state is real persisted D1; installed production/D1 identity is unqualified.

## Nullable source contract and failures

`docs/specification/DESIGN.md:124-133` explicitly gives `name:T?` a null default and permits explicit null. The actual unchanged artifact retains `nullable:true` on both `Bounded.Job.account` model metadata and its create/update input metadata. This is not a missing compiler declaration.

The frozen registry conversion at `packages/state/src/invocation/registry.ts:1093-1108` retains model/versioned/required/default for reference inputs but drops nullable. Admission at `invocation/admission.ts:219-227` therefore rejects explicit null as an invalid reference. Omission reaches the engine: `mutation/pipeline.ts:1047-1053` fills the known-nullable field with null, then `checkRefs` at `733-746` rejects that present null. The omitted path stores a rejection receipt; the explicit path fails before a receipt. The four retained failed predicates correctly include compounded creation/default and successful-replay expectations. None becomes a positive nullable/default workflow qualification.

## Import peers, integer carrier and read scope

The supported route uses the existing production **Cloudflare runtime stdlib peer**, supplied through the public assembler's documented URL mapping. The public `@canlang/stdlib` façade lacks the emitted `create`, `set`, and `deleteRecord` surface. Its actual Bounded preload fails with missing `create` before any receipt or revision change. No artifact body patch or combined custom stdlib shim was used.

The integer default has distinct observed representations: emitted `appDefinition` uses `1n`; descriptor wire default, actual returned CRUD data, and parsed stored D1 data use string `"1"`. Runtime/persisted row version is a number. These exact carriers are evidence, **not qualified integer semantics**. The independently reproduced NumericControl emits `int64(job.count + 1n)` but cannot preload on the Cloudflare peer (missing `int64`) or public peer (missing `create`). Both raw attempts remain revision zero with no rows/history/receipts. Expected numeric result 2 remains unexecuted and unqualified; no executed arithmetic outcome is inferred from the static field forwarding in `scenarioParameters`.

The initial author read predicate only tested array shape and was too weak. That review finding was resolved before freeze by preserving the earlier harness/receipt and adding one actual read-only production call over the final persisted DB. I independently verified its exact nonempty known Job id, version 3, changed title, count string, enabled flag, ready state and Account reference, deriving the expected Account id from the actual Account.create operation identity. Full SQL snapshots remain unchanged at revision 10. An explicit `inputs.fields` selector is an unsupported input and returns validation; this qualifies closed input refusal, not the source-declared selector/secrecy contract.

## Acceptance boundary

Other-team member denial at `ownerGate` proves the selected identity scope's owner predicate, not deployed owner-storage routing. This harness supplies a selected StoragePort, and bounded root rows have empty persisted owner. D1 restart recreates Miniflare/database/invoker while the host Node process remains alive; it is not a host-crash proof. Canonical generated CRUD uses the actual descriptor executor rather than the emitted CRUD handler body, while the emitted scenario handlers really execute the ordered edges/late guard. The canonical model table installs empty hooks, invariants and locks, so those integrations are outside these machine receipts.

Public MCP exposure, complete default/form/security workflows, scalar validation and hydration ownership, installed identity, source-declared selectors/secrecy, owner-storage routing, hooks/locks/invariants, duration language execution metadata, contextual defaults and full original applications remain open. The real numeric operation and both nullable paths require repair and subsequent qualification before the parent gate can close.

The earlier read assertion was the only packet assertion-scope issue found and was resolved by preserved supplemental evidence. No product repair, new policy decision, Git action, DECISIONS/JEV update or living-filetree change was made by this review. Only the reviewer Markdown/JSON and private reviewer scratch were written.
