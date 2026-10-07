# Repair queue

Reviewed planning queue based on `3ff5fbd66324869ba2277fdbe4333fb95256810b`. This queue organizes existing obligations; its 48 packet labels are **not 48 new tasks**. The canonical task ledger remains at 333 identities, unchanged. The 76 integration dispositions are references and remain non-additive. Execution is **not authorized** (`execution_authorized: false`).

Counts: **48 packets** — 20 ready, 27 blocked, 1 deferred. Ready means a finite implementation recipe is planned subject to future human release; it is not dispatch authorization or runtime acceptance.

## Sequence

1. Verify the current source/base and finite owner contracts; reuse unchanged narrow accepted evidence.
2. Release independent ready reductions and current-contract fixes separately; do not wait for every family.
3. Resolve each blocked packet’s exact contract, input, owner, or host prerequisite; qualify the matching selected consumer before cutover.
4. Run actual native, generated, installed, durable, and browser joins through their original dependency chains.
5. Retire only switched mechanics, then perform the original and selected independent joined review; do conditional evidence cleanup last.

## Coverage and ownership

The coverage ledger cross-references 333 canonical tasks, 114 finished-product duties, 316 responsibilities, 400 behavior contracts, 69 audit groups, 308 raw records, and 76 dispositions. These are accountability links; they do not prove behavior, runtime acceptance, or complete semantic coverage. DR08 is an alias of DC-01 (one candidate, not two obligations).

The conflict index records 44 exact-file conflicts. Acknowledgments are not yet claimed. Only exact successor packet IDs/files in that index establish future handoffs; historical packet labels do not grant leases. DR01 reduction and SSW07 correctness retain separate budgets and receipts. Compiler source/docs/tests remain with the compiler agent; this queue grants no compiler lease. Native preparation/release remains held. Root owns queue/decision/living-plan planning refresh; package owners hold future finite code leases.

## Gates

- **CONTRACT-release:** Per-affected-seam owner contract release is a ready planning unblocker on its existing task. No global policy/approval barrier. Consequential new choice requires repository JEV3; implementation remains blocked until release.
- **HELD-preparation:** Human-held native preparation P03–P11 / D05 / Q10 / EX12–13. Preserve current JS/CLI behavior and source facts; no activate/publish work.
- **PRODUCT-original-joins:** Original source-current compiler/durable/provider/browser/app joins remain required under their existing task owners. Foreign compiler writer supplies exact released producer inputs; this queue grants no compiler lease.
- **FINAL-R03:** Existing original R01/C01 and selected R03 joined review, after affected source/consumer releases; no broad acceptance from helpers.
- **EVIDENCE-cleanup:** Conditional EC evidence cleanup only after its retained source/oracle/negative gates; zero production savings.
- **RETAIN-oracles:** Retain original oracles, decisive negatives, generated supported outputs and true transaction/installed controls.

Common replacement, correctness, original-acceptance, security, native-preparation, ownership, and timer gates are defined once in `queue.json`; packet details below do not restate them. Preserve original task status/prerequisites and accepted helper scope. Old evidence credits remain limited to their recorded scope. Pending security review, native HOLD, and foreign compiler ownership remain active.

See [packets.md](packets.md) for packet-level task IDs, files, prerequisites, deletions, caller checks, and separate implementation/review settings.

## Independent challenge and verification

[Independent review](independent-review.md) verified seven corrections with no unresolved findings in its bounded planning scope. [Metadata verification](verification.json) passes 37/37 checks; rerun `python3 docs/research/package-library-audit-20261006/repair-queue/verify.py`. No product build/test was run.

Disposition records: 44 retained, 29 selected refinements and three human-held native simplifications. These are not added to the 48 packet count. Production reductions are unmeasured: replacement-only candidates must reduce both readable production implementation and implementation plus maintained declarations over the complete changed closure, or retain the current mechanism. Correctness/capability changes use a separate budget.

[Owner reconciliation](../../../ideal-filetree-plan/package-repair-queue-refresh.json) preserves the complete checkpoint and foreign compiler owner. Decisions are recorded in [decision-record.md](decision-record.md).

## Packet status index

The names below are packet labels refining existing IDs. Follow each link for exact files, prerequisites, deletions and positive/negative checks. The full machine DAG is `queue.json.topological_order`; shared-file conflicts are release constraints, not a global sequencing barrier.

### Ready

| Packet | Owner / work |
| --- | --- |
| [TECH-V01-values](packets.md#tech-v01-values) | VALUES · reduction |
| [TECH-V01-work](packets.md#tech-v01-work) | WORK · reduction |
| [TECH-W01-quote](packets.md#tech-w01-quote) | WORK · reduction |
| [TECH-S01](packets.md#tech-s01) | STATE · reduction |
| [TECH-W02](packets.md#tech-w02) | WORK / STATE · correctness |
| [TECH-SV04](packets.md#tech-sv04) | SERVICES / TESTKIT · reduction |
| [DEL-D01](packets.md#del-d01) | DELIVERY · reduction |
| [DEL-D02](packets.md#del-d02) | DELIVERY · reduction |
| [DEL-C02-order](packets.md#del-c02-order) | CSV / STATE JOIN · correctness |
| [REPLAY-IP07](packets.md#replay-ip07) | STATE / CLOUDFLARE · correctness |
| [PARSER-DP01](packets.md#parser-dp01) | INTERFACES · correctness |
| [VERIFY-TV01](packets.md#verify-tv01) | TEST EVIDENCE · qualification |
| [TECH-V02-violations](packets.md#tech-v02-violations) | VALUES · reduction |
| [TECH-V02-gregorian](packets.md#tech-v02-gregorian) | VALUES · reduction |
| [DEL-U01-appearance](packets.md#del-u01-appearance) | BROWSER / UI · reduction |
| [DEL-U01-draft](packets.md#del-u01-draft) | BROWSER / UI · reduction |
| [DEL-A01-error](packets.md#del-a01-error) | BROWSER / INTERFACES · reduction |
| [DEL-A01-binding](packets.md#del-a01-binding) | BROWSER / INTERFACES · reduction |
| [DEL-A01-admission](packets.md#del-a01-admission) | BROWSER / INTERFACES · reduction |
| [DEL-A01-canonical](packets.md#del-a01-canonical) | BROWSER / INTERFACES · reduction |

### Blocked

| Packet | Owner / work |
| --- | --- |
| [TECH-W01-uri](packets.md#tech-w01-uri) | WORK · reduction |
| [TECH-V03](packets.md#tech-v03) | VALUES · correctness |
| [TECH-V04](packets.md#tech-v04) | VALUES · qualification |
| [TECH-V05](packets.md#tech-v05) | VALUES · contract-qualification |
| [TECH-S01-own-key](packets.md#tech-s01-own-key) | STATE · security-correctness |
| [TECH-S02](packets.md#tech-s02) | STATE / WORK · security-correctness |
| [TECH-S03](packets.md#tech-s03) | STATE / IDENTITY · security-qualification |
| [TECH-W03](packets.md#tech-w03) | WORK · qualification |
| [TECH-I01](packets.md#tech-i01) | IDENTITY · security-correctness |
| [TECH-I02](packets.md#tech-i02) | IDENTITY / INTERFACES · contract-correctness |
| [TECH-F01](packets.md#tech-f01) | FILES · correctness |
| [TECH-F02](packets.md#tech-f02) | FILES / SOURCE INGRESS · qualification |
| [TECH-SV01](packets.md#tech-sv01) | SERVICES · security-correctness |
| [TECH-SV02](packets.md#tech-sv02) | SERVICES / WORK · security-qualification |
| [TECH-SV03](packets.md#tech-sv03) | SERVICES / FILES · contract-qualification |
| [DEL-C01](packets.md#del-c01) | CSV / INTERFACES · correctness |
| [DEL-C02](packets.md#del-c02) | CSV / STATE JOIN · correctness |
| [DEL-B01](packets.md#del-b01) | BROWSER · correctness |
| [DEL-B02](packets.md#del-b02) | BROWSER / INTERFACES · qualification |
| [DEL-D03](packets.md#del-d03) | DELIVERY · correctness |
| [DEL-D04](packets.md#del-d04) | DELIVERY / MAPS · contract-qualification |
| [DEL-R01](packets.md#del-r01) | DEPENDENCY / RELEASE · qualification |
| [DEL-E02](packets.md#del-e02) | TESTKIT / EVIDENCE CLEANUP · correctness-and-conditional-consolidation |
| [TECH-S04-admission](packets.md#tech-s04-admission) | STATE / WORK · resource-correctness |
| [TECH-S04-query](packets.md#tech-s04-query) | STATE / WORK · resource-correctness |
| [TECH-S04-cohort](packets.md#tech-s04-cohort) | STATE / WORK · resource-correctness |
| [FINAL-R03](packets.md#final-r03) | INDEPENDENT JOINED REVIEW · review |

### Deferred

| Packet | Owner / work |
| --- | --- |
| [DEL-D05](packets.md#del-d05) | HELD NATIVE PREPARATION · qualification |


## Economical dispatch settings

[Per-packet implementation/review allocation](model-allocation.md) covers all 48 packets. Each packet now has separate implementation/qualification and independent-review model/effort, with cheap prepared records/fixtures and concrete escalation gates. The old Sol/high field is historical planning evidence, not a blanket worker setting. Ordinary local review does not replace the existing critical gates. Three implementation lanes use finite packet-specific models; no implementation is released.

The 20 ready packets allocate four to Luna medium, five to Sol low, ten to Sol medium, and one to Sol high. Stronger blocked joins retain risk-matched settings; no model change releases their prerequisites. [Allocation consistency review](model-allocation-review.json) checks all 48 rows and preserves required critical reviews.
