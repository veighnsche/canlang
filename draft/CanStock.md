# CanStock requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanStock.can](CanStock.can).

## Purpose and Adoption Goal

Help workspace staff track coffee, cleaning supplies, stationery, access-card stock, and other consumables by location and storeroom. Adoption depends on knowing where stock is available and what needs replenishment.

## Users and Permissions

Require team authentication. Members manage their team's items and stock movements.

## Data and Ownership

Items have a team-unique SKU, whole-unit stock count, name, and non-negative reorder threshold. Posted movements record signed integer quantity, location, reason, operation identity, and actor/time. Balances derive from the ledger; corrections append linked reversal/replacement movements rather than editing or deleting posted entries.

Each location reference denotes a real site/storeroom under the operator; store a fixed whole-unit label such as box, pack, or bottle per SKU. Once movements exist, changing the unit requires a new SKU or explicit conversion migration, not relabeling old counts. Card stock records quantities, not active member access credentials.

Incoming delivery movements carry the immutable CanPurchase order-line/receipt identity and snapshot unit. Receipt quantity and location must match its trusted accepted receipt. Rejected goods do not enter usable stock; returned goods carry a linked receipt and reversal reference.

## Workflows and Business Rules

Check availability at the affected location, not just the item's total. Concurrent withdrawals cannot consume the same stock. A transfer posts its source deduction and destination addition together with one transfer identity; failure commits neither. The operator-total reorder indicator uses the configured total threshold; per-location indicators additionally use the applicable location threshold.

Staff can receive delivery, record consumption, transfer stock, and perform an attributed count adjustment with reason while retaining the ledger. Transfers require permission at both sites; a destination-only grant does not expose unrelated source stock. Optional supplier and purchase-authorization references identify replenishment evidence.

Post each accepted source receipt once using its stable receipt identity and reject conflicting quantity/unit/location reuse. A failed source-to-stock mirror stays pending and visible to both receipt and stock views. Returns check remaining usable stock at the affected location; insufficient stock requires staff investigation, never an invented balance or silent budget release.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Consumables /stock is the authenticated stock-staff sidebar destination, with only permitted locations visible. Item/threshold maintenance is ordinary stock work rather than a new administration console.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Stock-on-hand /stock | SKU List and location/storeroom balance Table, unit labels and separate operator-total/per-location reorder Badge; authorized site/low-stock filters. | Read ledger-derived balances; Item CRUD cannot relabel a posted unit or fabricate a balance. |
| Receiving and consumption | Typed quantity/location/reason Fieldset with source-receipt evidence and usable-stock summary. | adjust handles evidenced consumption/count adjustments; trusted accepted receipt posting uses the owning post operation, not editable imported quantities. |
| Transfer and correction | Source/destination Select, available quantities and paired-transfer result Alert; linked correction history in Collapse. | transfer needs both site grants and commits both movements together; reverse/correct append evidence rather than modify posted history. |
| Items, thresholds and movement history | Item/Threshold Fieldsets, per-site reorder Table, movement totals grouped by permitted location, and bounded Movement Table showing location, quantity, source/order, reason and actor/time. | Item/Threshold CRUD remains scoped; replayed receipts add once and returns check usable stock before reversal. |

On mobile, use labeled balance/movement Cards retaining SKU, fixed unit, location and receipt/correction linkage. Loading is distinct from a true zero balance or an empty ledger; stale availability requires authoritative recheck on withdrawal. A failed purchase-to-stock mirror remains pending with receipt identity visible, including rejected/returned quantities. Preserve both transfer selections and reason after insufficient-stock or stale-update errors. Archive actions retain histories, and access-card quantities never imply active door credentials. The existing shared CSV toolbar keeps identical location/field grants and readable units; it needs no app-specific export operation.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Optional personal settings remember an authorized storeroom and low-stock/history view filters, using the common validated persistent save/reset behavior. Reorder thresholds and SKU units are business records, not personal settings; saved filters cannot grant a source-site read or spend another site's stock. Supplier integrations, receipt bindings and retry configuration remain developer maintenance.

## Interfaces and Integrations

Use D1 for item and movement records.

## Background Actions

No periodic replenishment job is required; indicators derive from current stock. Where purchase receipts are connected, process identified pending receipt/return projections with bounded retry and visible reconciliation status.

## Error Handling

Explain insufficient location stock and invalid units/quantities. Repeated submission returns the original movement. An archived item retains its ledger; referenced locations cannot disappear from movement history.

## Scope and Completion

Complete when a transfer preserves total stock, a location cannot be overdrawn even if another location has stock, and repeated/concurrent withdrawals have correct outcomes.

Staff can receive coffee supplies, transfer boxes to another site, record consumption, and correct a count without allowing one site to spend another site's stock or rewriting history.

Replay of one partial purchase receipt adds stock once, rejected units add none, and a supplier return preserves the receipt/movement history.

Frontend acceptance journeys:

- Staff receives one partial purchase delivery, replays its evidence and sees only accepted units posted once. A rejected quantity never becomes usable stock; later return/correction remains linked to the receipt and ledger.
- Staff transfers boxes between two permitted sites: one atomic result preserves total stock. A source-site shortage or missing grant keeps both balances unchanged and retains the entered transfer for correction, even when another location has stock.

## Composition and Ownership

Recommended placement: Facilities. Own consumable SKUs and stock ledgers, with CanPurchase order/receipt references. CanMaintain owns individually tracked non-bookable assets and CanRent owns saleable resources. Composition does not merge these inventories. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Current authored draft — October 4, 2026

[CanStock.can](CanStock.can) and its [desired JavaScript target](CanStock.mjs) now declare the exact owner mapping: `StockV1.post` admits authenticated purchase-origin `StockIngressV1.post`, whose committed `PostOutcome` acknowledges a saved pending projection or a confirmed replay. `StockV1.changed` maps committed `ProjectionOutcome` after applying that projection. The installed binding must authenticate the purchase producer, fix team/location/source namespaces, retain the original operation/delivery and immutable request digest, and correlate each completion with its originating delivery. An arbitrary caller does not receive a stock-staff role, and no cross-deployment receipt-table query is assumed.

A durable `Projection` freezes source, typed receipt/return snapshot and location. Its scheduled application posts usable stock once or records a visible unknown-SKU/unit/shortage failure. Identical source replay reuses the projection; conflicting snapshots fail. Returns identify the original positive movement, enforce its remaining returnable quantity and the affected location's actual stock, and append a negative linked movement. Generic reversal cannot bypass the purchase return pipeline. Confirmed projections and posted movements stay immutable; staff can retry the same failed projection after investigation. Pending and failed projections appear in the stock queue and their verified outcomes update purchasing evidence.

Location thresholds show ledger-derived available quantity, threshold and reorder status; a scoped balance report covers authorized locations without a threshold row. Operator-total indicators need complete ledger access and are withheld when dependencies are unavailable. The balance form displays its typed result. Inline examples cover pending replay/conflicting snapshots, successful application, invalid unit/inactive SKU, linked returns, shortages and excess returned quantity. Existing consumption/overdraw examples remain.

Source parsing and JavaScript syntax checks pass. These are authored workflow/target corrections, not executed BDD, ingress attestation, D1 transaction or browser evidence. Scheduler, adapters, stock capability transport, library and renderer remain proposed implementation contracts; no automatic replenishment job is added.
