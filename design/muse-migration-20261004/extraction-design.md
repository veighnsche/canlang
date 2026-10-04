# N10 handoff — Document extraction extension for Purchase and Expense

Status: **User-authorized 2026-10-04 (coordinator-authored; no prior extraction handoff exists). Codex review pending.** Design only; no app file has been changed by this handoff. Baseline: `903be47f9ab115b222cc31d9f30c2883dc056b4a`, specifically `draft/CanPurchase.can`/`.mjs`/`.md`, `draft/CanExpense.can`/`.mjs`/`.md`, `draft/MIGRATION.md` (C8 row), `design/AI-AND-SERVICE-DRAFTS.md` (document-to-purchase pack row), DESIGN §§2, 3, 4, 5.1, 8, 9, 13. Apply against current files without reverting concurrent routine corrections. The handoff owns no shared-language change: no DESIGN, GRAMMAR, REQUIREMENTS, compiler, stdlib, or infrastructure design.

## Decision and requirements text

Extend `CanPurchase` with a staff-reviewed supplier-invoice document journey and `CanExpense` with a claimant-transcribed receipt journey, using existing owners, roles, and authority. There is no OCR, model, or provider extraction in this bounded v1 (coordinator decision D1 below): a human transcribes the claimed totals from frozen document pages, the system enforces exact-money equality and duplicate/source identity, and the owning reviewer accepts or rejects the reviewed version. Malformed or mismatched claims remain failures or visible correction work, never valid business facts.

**Purchase.** `InvoiceDocument in Order` freezes one supplier invoice file (`document:file`, finalized immutable pages under the existing file flow) under a globally unique `source` identity. Claims (`invoice`/`amount`/`issued`, all nullable until transcribed) move `status` through `draft → transcribed → accepted | rejected`. Intake (`intake_invoice`, buyer) requires an approved or closed parent request; a duplicate source fails instead of silently overwriting or upserting (LegacyExpense precedent). Transcription (`transcribe_claims`, buyer) sets or corrects claims while draft/transcribed and requires order-currency money. Acceptance (`accept_invoice`, budget_manager) requires the transcribed status, a closed parent request, exact confirmation of all three stored claims, and the same affordability bound as `record_payable`; it creates the `Payable` with the document's source identity and links it. Rejection (`reject_invoice`, budget_manager) records a reason and is terminal; a new intake preserves the rejected record. The created `Payable` flows into the unchanged `export_payable` accounting path. `record_payable` itself is unchanged and remains available for directly evidenced invoices.

**Expense.** `ReceiptExtract in Expense` holds one immutable claimant transcription (`source` unique, `amount`, `spent_on`, `merchant`). Transcription (`transcribe_receipt`, claimant, draft only) requires location-currency, positive money. `submit` additionally requires at least one transcription exactly matching claim amount and business date; corrections are new rows, never edits (Decision-history preservation precedent). The existing reviewer `decide`, `withdraw`, `correct`, and finance `reimburse` journey is otherwise unchanged; reviewers compare extracts against the frozen receipt file.

**Requirements edits:** in `draft/CanPurchase.md`, add a paragraph stating the invoice-document intake/transcription/review journey, exact-claim acceptance into `Payable`, duplicate-source failure, and terminal rejection with fresh-intake correction; extend the delivery/closure page row with the document table. In `draft/CanExpense.md`, state the draft-stage transcription requirement, exact-match submit guard, and immutable correction rows. Existing installations have no automatic backfill: previously submitted expenses without a transcription keep their current state; only new `submit` calls enforce the guard. No “extracted by automation” claim is allowed: these are staff attestations over frozen files.

## Coordinator-decided choices (user-authorized; Codex review pending)

No inbox READY exists for N10, so every genuinely new choice below is flagged with its alternatives and evidence. All Can/JS shapes used are precedented; citations give the exact source line.

- **D1. Manual staff transcription v1; no extraction provider.** The pack row proposes “OCR/structured extraction” but adopts no contract, and no `std` extraction capability is settled (DESIGN §8 standard table has Email/Payments/Errors only). Designing a provider, adapter, or mapping would be infrastructure design, which is out of scope. Alternative: bound `DocumentExtractionV1` capability with `delivery()` association on the `Stock.post` precedent (`CanPurchase.can:150`, `CanPurchase.mjs:1142`) — deferred as an explicit follow-up; the seam is preserved (frozen `document` file, unique `source`, `status`), so a future provider send can propose claims that still pass human transcription review before acceptance.
- **D2. `InvoiceDocument in Order`; `ReceiptExtract in Expense`.** Payable evidence, affordability sums, and receipt replay all live under Order (`CanPurchase.can:38,213`); placing the document there keeps one owner transaction and no cross-owner reads (DESIGN §7). Alternatives: under Request (rejected: claims are per-order and affordability is order-scoped) or top-level (rejected: breaks containment atomicity).
- **D3. Duplicate document source fails; no authored replay.** `receive`/`record_payable` replay by comparing saved scalar facts (`CanPurchase.can:143-146,209-212`), but file bytes have no settled guard-equality (DESIGN §3: opaque file equality not newly defined), so byte comparison in `require` would invent semantics. `retain_legacy` fails on duplicate source keys instead (`CanExpense.can:247`). Same-operation retries still replay through runtime receipt identity (DESIGN §7); only a fresh operation with a taken source fails.
- **D4. `accept_invoice` confirms exact values via parameters and creates `Payable` directly with mirrored guards.** The `!=null`-then-access `and`-chain is the settled nullable-read shape (`stock_result`, `CanPurchase.can:254`; `payable_result`, `:292`); money/date equality follows `reimburse` (`CanExpense.can:225`) and `record_payable` replay (`CanPurchase.mjs:1261-1263`). Alternatives: (a) `call record_payable` from `accept_invoice` — rejected for this handoff: no reviewed production-body `call` precedent exists in these two apps, and the two-line affordability guard mirrors `record_payable:213` exactly; (b) tolerance/fuzzy match — rejected: new business policy, violates the exact-money rule (DESIGN §3: matching currencies, no conversion).
- **D5. `submit` requires a matching transcription (behavior change to a reviewed scenario).** Without enforcement the transcription is advisory decoration and the pack goal (“correct discrepancies and accept the reviewed version”) has no teeth. The `any(... == ...)` shape mirrors existing guards (`CanPurchase.can:47`). Alternative: advisory-only transcription — rejected (see above). Exact example updates are specified below; no other submit guard changes.
- **D6. Multiple `ReceiptExtract` rows allowed; corrections are new rows.** Mirrors immutable Decision history (`CanExpense.can:12,31`) and the single-successor correction that preserves originals (`:208-209`). Alternative: one mutable row — rejected (loses correction evidence).
- **D7. Rejection is terminal; correction uses fresh intake.** Mirrors the rejected-claim successor pattern where the original is preserved. Alternative: re-transcribe after reject — rejected (rewrites review evidence).
- **D8. Purchase journey covered by tables; no new buyer/budget_manager actor fixtures.** Isolated-table `as` role callers are settled (DESIGN §5.1); shared-state sequences need user+Employee fixtures with `can_work` eligibility, which would require an import change (`Employee` is not imported by `CanPurchase.can:7`) plus new fixtures. A purchase shared-state sequence is specified as follow-up, not in this witness. Expense sequences use existing fixtures only.
- **D9. Version binding via standard record-version admission (`conflict` on stale), no stored revision field.** Mutation record inputs carry expected versions and stale submissions conflict (DESIGN §§5, 5.1; `CanExpense.can:97,186` rows). Alternative: stored `reviewed_version` — rejected (duplicates runtime versions).

## Exact affected files (for the future implementation task, not this handoff)

1. `draft/CanPurchase.can`: one model, one policy, four invariants, two locks, four scenarios, two fixtures, examples, one page-table addition below.
2. `draft/CanPurchase.mjs`: corresponding schema, rule maps, operation metadata/handlers, `disabled` additions, page-table addition below.
3. `draft/CanPurchase.md`: requirements paragraph and page-row update above.
4. `draft/CanExpense.can`: one model, three policies, one invariant, one lock, one scenario, one `submit` guard addition, one fixture, examples, two page-list additions below.
5. `draft/CanExpense.mjs`: corresponding schema, rule maps, operation metadata/handler, `submit` handler addition, `disabled` additions, page-list additions below.
6. `draft/CanExpense.md`: requirements paragraph above.
7. `draft/MIGRATION.md`: coordinator evidence disposition only after actual application/checks. No changes to DESIGN, GRAMMAR, REQUIREMENTS, compiler, or library.

## Can changed-section witness — purchase

In Given, add after the `Payable` model block (`CanPurchase.can:38`) and its rules; keep all existing declarations/policies/locks/fixtures:

```can
  InvoiceDocument in Order { document:file label="Invoice document"@{nl="Factuurdocument"}, source:text unique label=label_Receipt_source, status:enum(draft,transcribed,accepted,rejected)=draft label={text="Extraction review"@{nl="Extractiebeoordeling"},values={draft="Draft"@{nl="Concept"},transcribed="Transcribed"@{nl="Overgenomen"},accepted="Accepted"@{nl="Geaccepteerd"},rejected="Rejected"@{nl="Afgewezen"}}}, invoice:text? label="Claimed invoice number"@{nl="Geclaimd factuurnummer"}, amount:money? label="Claimed amount"@{nl="Geclaimd bedrag"}, issued:date? label="Claimed issue date"@{nl="Geclaimde uitgiftedatum"}, decision:text? label="Decision"@{nl="Besluit"}, payable:Payable? label="Accepted payable"@{nl="Geaccepteerde schuld"} } label="Supplier invoice document"@{nl="Leveranciersfactuurdocument"}
  policy InvoiceDocument read=buyer or budget_manager where=can_work(actor,row.parent.location)
  invariant InvoiceDocument: row.status==draft or (row.invoice!=null and row.amount!=null and row.issued!=null)
  invariant InvoiceDocument: (row.amount ?? row.parent.parent.amount).currency==row.parent.parent.amount.currency
  invariant InvoiceDocument: row.status!=accepted or (row.payable!=null and row.payable.parent==row.parent and row.payable.source==row.source)
  invariant InvoiceDocument: not any(InvoiceDocument as other,other!=row and other.source==row.source)
  lock InvoiceDocument fields=document,source
  lock InvoiceDocument fields=status,invoice,amount,issued,decision,payable when=row.status==accepted or row.status==rejected
```

The policy mirrors `Payable.read.1` (`CanPurchase.can:58`). The `??` currency check mirrors `record_payable`'s `actual??money(0,...)` (`:213`); the `!=null`-then-access chains mirror `stock_result` (`:254`). No `archived=include` duplicate scope: the model has no delete path, so archived rows cannot occur. No `crud` declaration: this follows the closed-world non-crud-model convention (J03 evidence), with all three operations disabled in JS.

Add fixtures after `goods_receipt` (`CanPurchase.can:88`):

```can
  fixture invoice_pdf=file {}
  fixture invoice_doc=InvoiceDocument {parent=purchase_order,document=invoice_pdf,source="invoice-doc-1",status=transcribed,invoice="SUP-001",amount=money(20,"EUR"),issued=date("2099-01-03")}
  fixture filed_payable=Payable {parent=purchase_order,source="invoice-doc-8",invoice="SUP-008",amount=money(10,"EUR"),issued=date("2099-01-03"),evidence="Filed supplier invoice"}
  fixture accepted_doc=InvoiceDocument {parent=purchase_order,document=invoice_pdf,source="invoice-doc-8",status=accepted,invoice="SUP-008",amount=money(10,"EUR"),issued=date("2099-01-03"),payable=filed_payable}
```

`accepted_doc` exists because an `accepted` row-override of `invoice_doc` would violate the accepted invariant (no linked payable) and fail setup instead of testing the terminal guard.

In When, add after the `record_payable` scenario (`CanPurchase.can:206-221`); `record_payable`, `export_payable`, and all other scenarios are unchanged:

```can
  # Intake one supplier invoice document under its order; a duplicate source fails instead of silently overwriting. @{nl="Neem één leveranciersfactuurdocument in onder de bestelling; een dubbele bron faalt in plaats van stil te overschrijven."}
  scenario intake_invoice(order:Order,document:file,source:text label=label_Receipt_source) -> InvoiceDocument by=buyer label="Intake invoice document"@{nl="Factuurdocument innemen"}
   require can_work(actor,order.location) and order.parent.state in [approved,closed] and trim(source)!=""
   do
    require not any(InvoiceDocument as item,item.source==trim(source))
    create InvoiceDocument {parent=order,document,source=trim(source)} as invoice_document
    return invoice_document
  # Transcribe or correct the claimed invoice totals from the frozen document pages. @{nl="Neem de geclaimde factuurtotalen over van de vastgelegde documentpagina's of corrigeer ze."}
  scenario transcribe_claims(invoice_document:InvoiceDocument,invoice:text,amount:money,issued:date) by=buyer label="Transcribe invoice claims"@{nl="Factuurgegevens overnemen"}
   require can_work(actor,invoice_document.parent.location) and invoice_document.status in [draft,transcribed] and trim(invoice)!="" and amount.currency==invoice_document.parent.parent.amount.currency and amount.minor>=0
   do set invoice_document {invoice=trim(invoice),amount,issued,status=transcribed}
  # Accept the reviewed claims as payable evidence against closed spending. @{nl="Accepteer de beoordeelde claims als schuldbewijs tegen afgesloten uitgaven."}
  scenario accept_invoice(invoice_document:InvoiceDocument,invoice:text,amount:money,issued:date,evidence:text) -> Payable by=budget_manager label="Accept invoice document"@{nl="Factuurdocument accepteren"}
   require can_work(actor,invoice_document.parent.location) and invoice_document.status==transcribed and invoice_document.parent.parent.state==closed and trim(invoice)!="" and trim(evidence)!=""
   do
    require invoice_document.invoice!=null and invoice_document.invoice==invoice and invoice_document.amount!=null and invoice_document.amount==amount and invoice_document.issued!=null and invoice_document.issued==issued
    require sum(invoice_document.parent.Payable as payable select payable.amount,amount.currency)+amount<=(invoice_document.parent.parent.actual??money(0,amount.currency))+sum(invoice_document.parent.parent.parent.Adjustment as adjustment where adjustment.request==invoice_document.parent.parent select adjustment.amount,amount.currency)
    create Payable {parent=invoice_document.parent,source=invoice_document.source,invoice,amount,issued,evidence} as payable
    set invoice_document {status=accepted,payable}
    return payable
  # Reject transcribed claims with a reason while retaining the frozen document. @{nl="Wijs overgenomen claims af met een reden en behoud het vastgelegde document."}
  scenario reject_invoice(invoice_document:InvoiceDocument,reason:text) by=budget_manager label="Reject invoice document"@{nl="Factuurdocument afwijzen"}
   require can_work(actor,invoice_document.parent.location) and invoice_document.status==transcribed and trim(reason)!=""
   do set invoice_document {status=rejected,decision=trim(reason)}
```

The affordability guard mirrors `record_payable:213` line-for-line with `order=invoice_document.parent`. State changes use the existing atomic owner transaction, input/version admission, final invariant checks, locks, and receipt replay. A stale submitted version conflicts before body guards; a claim mismatch, over-affordable amount, duplicate invoice (existing `unique Payable fields=invoice`, `:72`), or duplicate payable source fails with `rule_failed` and leaves no `Payable`, link, or partial acceptance.

In Then, inside the Order detail (`CanPurchase.can:323-327`), insert after the `Payable` table block (after `action export_payable`, before `table row.Line`):

```can
       form intake_invoice
       table row.InvoiceDocument columns=document,source,status,invoice,amount,issued,decision order=created
        actions transcribe_claims,accept_invoice,reject_invoice
```

The `intake_invoice` form auto-binds `order` from the current Order row; `document`/`source` remain inputs. The review actions auto-bind `invoice_document`; remaining claim/evidence inputs open their generated form. File-column rendering follows the existing `receipt` table column (`CanExpense.can:335`).

## Can changed-section witness — expense

In Given, add after the `Reimbursement` model (`CanExpense.can:13`); keep all existing declarations/policies/locks/fixtures:

```can
  ReceiptExtract in Expense { source:text unique label="Extraction source"@{nl="Extractiebron"}, amount:money, spent_on:date label="Receipt date"@{nl="Bondatum"}, merchant:text label="Merchant"@{nl="Verkoper"} } label="Receipt transcription"@{nl="Bontranscriptie"}
  policy ReceiptExtract read=authenticated where=row.parent.parent.user==actor
  policy ReceiptExtract read=reviewer where=row.parent.reviewer==actor and can_work(actor,row.parent.location) and row.parent.status!=draft
  policy ReceiptExtract read=finance and can_work(actor,row.parent.location)
  invariant ReceiptExtract: row.amount.minor>0 and row.amount.currency==row.parent.location.currency and trim(row.merchant)!=""
  lock ReceiptExtract fields=source,amount,spent_on,merchant
```

The three policies mirror the `Expense` read rules (`CanExpense.can:22-24`) with one extra parent traversal; the invariant mirrors `Expense.require.1` (`:27`). Rows are unconditionally locked: corrections are new rows (D6). No `crud` declaration (closed-world convention, as above).

Add the fixture after `previous_payment` (`CanExpense.can:48`):

```can
  fixture receipt_extract=ReceiptExtract {parent=claim,source="extract-1",amount=money(25,"EUR"),spent_on=date("2026-10-01"),merchant="Station kiosk"}
```

It matches `claim`'s amount and business date, so seeded `submit` rows succeed.

In When, replace the complete `submit` require (`CanExpense.can:87`) with this line and extend its `#` description; the `do` body is unchanged:

```can
  scenario submit(expense:Expense) by=members
   require expense.parent.user==actor and expense.parent.active and expense.status==draft and can_work(actor,expense.location) and expense.reviewer!=actor and reviewer(expense.reviewer) and can_work(expense.reviewer,expense.location) and any(expense.ReceiptExtract as extract,extract.amount==expense.amount and extract.spent_on==expense.business_date)
```

New description: `# Submit your draft after checking the active, distinct reviewer and an exact receipt transcription. @{nl="Dien je concept in na controle van een actieve, andere beoordelaar en een exacte bontranscriptie."}`

Add after the `submit` scenario (before `decide`, `:166`):

```can
  # Transcribe the claimed totals from the frozen receipt while the claim is a draft. @{nl="Neem de geclaimde totalen over van de vastgelegde bon terwijl de declaratie een concept is."}
  scenario transcribe_receipt(expense:Expense,source:text,amount:money,spent_on:date,merchant:text) -> ReceiptExtract by=members label="Transcribe receipt claims"@{nl="Bonclaims overnemen"}
   require expense.parent.user==actor and expense.parent.active and can_work(actor,expense.location) and expense.status==draft and trim(source)!="" and trim(merchant)!="" and amount.currency==expense.location.currency and amount.minor>0
   do
    require not any(ReceiptExtract as extract,extract.source==trim(source))
    create ReceiptExtract {parent=expense,source=trim(source),amount,spent_on,merchant=trim(merchant)} as extract
    return extract
```

In Then, in “Own claim and receipt” (`CanExpense.can:323-331`) insert after `actions submit,withdraw,correct`:

```can
     form transcribe_receipt
     list row.ReceiptExtract
      text row.source,row.merchant,row.amount,row.spent_on
```

In “Frozen claim review” (`CanExpense.can:336-338`) insert after `actions decide,reimburse`:

```can
     list row.ReceiptExtract
      text row.source,row.merchant,row.amount,row.spent_on
```

Both forms auto-bind `expense` from the current claim row. No page admission changes: the lists inherit the existing claim/review/finance grants.

## Desired JavaScript changed-section witness — purchase

Merge entries into existing objects; preserve existing maps/handlers. No new imports are required (`any`, `check`, `compareDate`, `compareMoney`, `addMoney`, `equalMoney`, `create`, `first`, `money`, `records`, `same`, `set`, `sum`, `form`, `table`, `actions`, `message` are already imported). No new runtime/UI helper.

```js
// Add to appDefinition.models:
"purchase.InvoiceDocument": {
  parent: "purchase.Order",
  label: message("Supplier invoice document", { nl: "Leveranciersfactuurdocument" }),
  fields: {
    document: { type: "file", label: message("Invoice document", { nl: "Factuurdocument" }) },
    source: { type: "text", unique: true, label: sourceCaption },
    status: {
      type: "enum",
      cases: ["draft", "transcribed", "accepted", "rejected"],
      default: "draft",
      label: {
        text: message("Extraction review", { nl: "Extractiebeoordeling" }),
        values: {
          draft: message("Draft", { nl: "Concept" }),
          transcribed: message("Transcribed", { nl: "Overgenomen" }),
          accepted: message("Accepted", { nl: "Geaccepteerd" }),
          rejected: message("Rejected", { nl: "Afgewezen" }),
        },
      },
    },
    invoice: {
      type: "text", nullable: true,
      label: message("Claimed invoice number", { nl: "Geclaimd factuurnummer" }),
    },
    amount: {
      type: "money", nullable: true,
      label: message("Claimed amount", { nl: "Geclaimd bedrag" }),
    },
    issued: {
      type: "date", nullable: true,
      label: message("Claimed issue date", { nl: "Geclaimde uitgiftedatum" }),
    },
    decision: { type: "text", nullable: true, label: message("Decision", { nl: "Besluit" }) },
    payable: {
      type: "purchase.Payable", nullable: true,
      label: message("Accepted payable", { nl: "Geaccepteerde schuld" }),
    },
  },
  readGrants: [{ rule: "InvoiceDocument.read.1" }],
  invariants: [
    "InvoiceDocument.require.1",
    "InvoiceDocument.require.2",
    "InvoiceDocument.require.3",
    "InvoiceDocument.require.4",
  ],
  locks: ["InvoiceDocument.lock.1", "InvoiceDocument.lock.2"],
},
// Add to appDefinition.operations:
"purchase.intake_invoice": {
  handler: "intake_invoice",
  by: buyer,
  read: false,
  result: "purchase.InvoiceDocument",
  inputs: {
    order: { type: "purchase.Order" },
    document: { type: "file" },
    source: { type: "text", label: sourceCaption },
  },
  label: message("Intake invoice document", { nl: "Factuurdocument innemen" }),
  description: message(
    "Intake one supplier invoice document under its order; a duplicate source fails instead of silently overwriting.",
    { nl: "Neem één leveranciersfactuurdocument in onder de bestelling; een dubbele bron faalt in plaats van stil te overschrijven." },
  ),
},
"purchase.transcribe_claims": {
  handler: "transcribe_claims",
  by: buyer,
  read: false,
  inputs: {
    invoice_document: { type: "purchase.InvoiceDocument" },
    invoice: { type: "text" },
    amount: { type: "money" },
    issued: { type: "date" },
  },
  label: message("Transcribe invoice claims", { nl: "Factuurgegevens overnemen" }),
  description: message(
    "Transcribe or correct the claimed invoice totals from the frozen document pages.",
    { nl: "Neem de geclaimde factuurtotalen over van de vastgelegde documentpagina's of corrigeer ze." },
  ),
},
"purchase.accept_invoice": {
  handler: "accept_invoice",
  by: budget_manager,
  read: false,
  result: "purchase.Payable",
  inputs: {
    invoice_document: { type: "purchase.InvoiceDocument" },
    invoice: { type: "text" },
    amount: { type: "money" },
    issued: { type: "date" },
    evidence: { type: "text" },
  },
  label: message("Accept invoice document", { nl: "Factuurdocument accepteren" }),
  description: message(
    "Accept the reviewed claims as payable evidence against closed spending.",
    { nl: "Accepteer de beoordeelde claims als schuldbewijs tegen afgesloten uitgaven." },
  ),
},
"purchase.reject_invoice": {
  handler: "reject_invoice",
  by: budget_manager,
  read: false,
  inputs: {
    invoice_document: { type: "purchase.InvoiceDocument" },
    reason: { type: "text" },
  },
  label: message("Reject invoice document", { nl: "Factuurdocument afwijzen" }),
  description: message(
    "Reject transcribed claims with a reason while retaining the frozen document.",
    { nl: "Wijs overgenomen claims af met een reden en behoud het vastgelegde document." },
  ),
},
// Append to appDefinition.disabled:
"purchase.InvoiceDocument.create",
"purchase.InvoiceDocument.update",
"purchase.InvoiceDocument.delete",
```

Complete map additions and handlers for `canApp()`:

```js
// Add to the read map:
"InvoiceDocument.read.1": async (c, row) =>
  (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
  (await can_work(c, c.actor, row.parent.location)),
// Add to the invariants map:
"InvoiceDocument.require.1": (c, row) =>
  row.status === "draft" || (row.invoice !== null && row.amount !== null && row.issued !== null),
"InvoiceDocument.require.2": (c, row) =>
  (row.amount ?? row.parent.parent.amount).currency === row.parent.parent.amount.currency,
"InvoiceDocument.require.3": (c, row) =>
  row.status !== "accepted" ||
  (row.payable !== null && same(row.payable.parent, row.parent) && row.payable.source === row.source),
"InvoiceDocument.require.4": async (c, row) =>
  !(await any(
    records(c, "purchase.InvoiceDocument"),
    (other) => !same(other, row) && other.source === row.source,
  )),
// Add to the locks map:
"InvoiceDocument.lock.1": { fields: ["document", "source"] },
"InvoiceDocument.lock.2": {
  fields: ["status", "invoice", "amount", "issued", "decision", "payable"],
  when: (c, row) => row.status === "accepted" || row.status === "rejected",
},

// Add these complete canApp() methods (after record_payable):
async intake_invoice(c, { order, document, source }) {
  check(hasRole(c, buyer), "forbidden");
  check(
    (await can_work(c, c.actor, order.location)) &&
      ["approved", "closed"].includes(order.parent.state) &&
      source.trim() !== "",
  );
  check(
    !(await any(
      records(c, "purchase.InvoiceDocument"),
      (item) => item.source === source.trim(),
    )),
  );
  return await create(c, "purchase.InvoiceDocument", {
    parent: order,
    document,
    source: source.trim(),
  });
},
async transcribe_claims(c, { invoice_document, invoice, amount, issued }) {
  check(hasRole(c, buyer), "forbidden");
  check(
    (await can_work(c, c.actor, invoice_document.parent.location)) &&
      ["draft", "transcribed"].includes(invoice_document.status) &&
      invoice.trim() !== "" &&
      amount.currency === invoice_document.parent.parent.amount.currency &&
      amount.minor >= 0n,
  );
  await set(c, invoice_document, {
    invoice: invoice.trim(),
    amount,
    issued,
    status: "transcribed",
  });
},
async accept_invoice(c, { invoice_document, invoice, amount, issued, evidence }) {
  check(hasRole(c, budget_manager), "forbidden");
  check(
    (await can_work(c, c.actor, invoice_document.parent.location)) &&
      invoice_document.status === "transcribed" &&
      invoice_document.parent.parent.state === "closed" &&
      invoice.trim() !== "" &&
      evidence.trim() !== "",
  );
  check(
    invoice_document.invoice !== null &&
      invoice_document.invoice === invoice &&
      invoice_document.amount !== null &&
      equalMoney(invoice_document.amount, amount) &&
      invoice_document.issued !== null &&
      compareDate(invoice_document.issued, issued) === 0,
  );
  const order = invoice_document.parent;
  check(
    compareMoney(
      addMoney(
        await sum(
          records(c, "purchase.Payable", { parent: order }),
          (payable) => payable.amount,
          amount.currency,
        ),
        amount,
      ),
      addMoney(
        order.parent.actual ?? money(0n, amount.currency),
        await sum(
          records(c, "purchase.Adjustment", {
            parent: order.parent.parent,
            where: (adjustment) => same(adjustment.request, order.parent),
          }),
          (adjustment) => adjustment.amount,
          amount.currency,
        ),
      ),
    ) <= 0,
  );
  const payable = await create(c, "purchase.Payable", {
    parent: order,
    source: invoice_document.source,
    invoice,
    amount,
    issued,
    evidence,
  });
  await set(c, invoice_document, { status: "accepted", payable });
  return payable;
},
async reject_invoice(c, { invoice_document, reason }) {
  check(hasRole(c, budget_manager), "forbidden");
  check(
    (await can_work(c, c.actor, invoice_document.parent.location)) &&
      invoice_document.status === "transcribed" &&
      reason.trim() !== "",
  );
  await set(c, invoice_document, { status: "rejected", decision: reason.trim() });
},
```

The affordability `check` mirrors `record_payable` (`CanPurchase.mjs:1267-1289`) with `order=invoice_document.parent`; money/date equality mirrors its replay check (`:1259-1264`).

In `purchasingPage`, inside the Order `renderRow` after the `Payable` table (after the `export_payable` action child, before the `Line` table), insert:

```js
form({ context: ov, operation: "purchase.intake_invoice", arguments: { order } }),
table({
  context: ov,
  model: "purchase.InvoiceDocument",
  parent: order,
  columns: ["document", "source", "status", "invoice", "amount", "issued", "decision"],
  order: ["created"],
  renderRow: (invoice_document, iv) => [
    actions({
      context: iv,
      operations: [
        "purchase.transcribe_claims",
        "purchase.accept_invoice",
        "purchase.reject_invoice",
      ],
      boundArgs: { invoice_document },
    }),
  ],
}),
```

## Desired JavaScript changed-section witness — expense

Merge entries into existing objects; preserve existing maps/handlers. No new imports are required (`any`, `check`, `compareDate`, `create`, `equalMoney`, `records`, `same`, `set`, `form`, `list`, `text`, `message` are already imported). No new runtime/UI helper.

```js
// Add to appDefinition.models:
"expense.ReceiptExtract": {
  parent: "expense.Expense",
  label: message("Receipt transcription", { nl: "Bontranscriptie" }),
  fields: {
    source: {
      type: "text", unique: true,
      label: message("Extraction source", { nl: "Extractiebron" }),
    },
    amount: { type: "money" },
    spent_on: { type: "date", label: message("Receipt date", { nl: "Bondatum" }) },
    merchant: { type: "text", label: message("Merchant", { nl: "Verkoper" }) },
  },
  readGrants: [
    { rule: "ReceiptExtract.read.1" },
    { rule: "ReceiptExtract.read.2" },
    { rule: "ReceiptExtract.read.3" },
  ],
  invariants: ["ReceiptExtract.require.1"],
  locks: ["ReceiptExtract.lock.1"],
},
// Add to appDefinition.operations:
"expense.transcribe_receipt": {
  handler: "transcribe_receipt",
  by: "members",
  read: false,
  result: "expense.ReceiptExtract",
  inputs: {
    expense: { type: "expense.Expense" },
    source: { type: "text" },
    amount: { type: "money" },
    spent_on: { type: "date" },
    merchant: { type: "text" },
  },
  label: message("Transcribe receipt claims", { nl: "Bonclaims overnemen" }),
  description: message(
    "Transcribe the claimed totals from the frozen receipt while the claim is a draft.",
    { nl: "Neem de geclaimde totalen over van de vastgelegde bon terwijl de declaratie een concept is." },
  ),
},
// Append to appDefinition.disabled:
"expense.ReceiptExtract.create",
"expense.ReceiptExtract.update",
"expense.ReceiptExtract.delete",
```

```js
// Add to the read map:
"ReceiptExtract.read.1": (c, row) =>
  hasRole(c, "authenticated") && same(row.parent.parent.user, c.actor),
"ReceiptExtract.read.2": async (c, row) =>
  hasRole(c, "expense.reviewer") &&
  same(row.parent.reviewer, c.actor) &&
  (await can_work(c, c.actor, row.parent.location)) &&
  row.parent.status !== "draft",
"ReceiptExtract.read.3": async (c, row) =>
  hasRole(c, "expense.finance") && (await can_work(c, c.actor, row.parent.location)),
// Add to the invariants map:
"ReceiptExtract.require.1": (c, row) =>
  row.amount.minor > 0n &&
  row.amount.currency === row.parent.location.currency &&
  row.merchant.trim() !== "",
// Add to the locks map:
"ReceiptExtract.lock.1": { fields: ["source", "amount", "spent_on", "merchant"] },

// Add this complete canApp() method (after submit):
async transcribe_receipt(c, { expense, source, amount, spent_on, merchant }) {
  check(hasRole(c, "members"), "forbidden");
  check(
    same(expense.parent.user, c.actor) &&
      expense.parent.active &&
      (await can_work(c, c.actor, expense.location)) &&
      expense.status === "draft" &&
      source.trim() !== "" &&
      merchant.trim() !== "" &&
      amount.currency === expense.location.currency &&
      amount.minor > 0n,
  );
  check(
    !(await any(
      records(c, "expense.ReceiptExtract"),
      (extract) => extract.source === source.trim(),
    )),
  );
  return await create(c, "expense.ReceiptExtract", {
    parent: expense,
    source: source.trim(),
    amount,
    spent_on,
    merchant: merchant.trim(),
  });
},

// Replace the complete submit guard check with this (body unchanged):
check(
  same(expense.parent.user, c.actor) &&
    expense.parent.active &&
    expense.status === "draft" &&
    (await can_work(c, c.actor, expense.location)) &&
    !same(expense.reviewer, c.actor) &&
    hasRole(c, "expense.reviewer", expense.reviewer) &&
    (await can_work(c, expense.reviewer, expense.location)) &&
    (await any(
      records(c, "expense.ReceiptExtract", { parent: expense }),
      (extract) =>
        equalMoney(extract.amount, expense.amount) &&
        compareDate(extract.spent_on, expense.business_date) === 0,
    )),
);
```

In `minePage`, inside the “Own claim and receipt” card after the `submit`/`withdraw`/`correct` actions child, insert:

```js
form({ context: rowView, operation: "expense.transcribe_receipt", arguments: { expense } }),
list({
  context: rowView,
  model: "expense.ReceiptExtract",
  parent: expense,
  renderRow: (extract, extractView) => [
    text({
      context: extractView,
      values: [extract.source, extract.merchant, extract.amount, extract.spent_on],
    }),
  ],
}),
```

In `reviewPage`, inside the “Frozen claim review” card after the `decide`/`reimburse` actions child, insert the same `list` block (no form: reviewers do not transcribe). `rowView`/`expense` names follow the enclosing card's existing bindings.

## Acceptance and failure examples

Retain all existing tables and sequences. Add the following complete isolated tables. Fixture versions start at 1, so `request.*.version=2` submits a stale version (`CanExpense.can:97` precedent).

Purchase — attach to the four new scenarios:

```can
   examples seed=[test_worker,invoice_pdf] order=purchase_order document=invoice_pdf
    as,order.parent.state,source -> count(InvoiceDocument),result.status,result.source
    buyer,approved,"invoice-doc-2" -> 1,draft,"invoice-doc-2"
    buyer,closed,"invoice-doc-2" -> 1,draft,"invoice-doc-2"
    buyer,submitted,"invoice-doc-2" -> error(rule_failed)
    buyer,approved," " -> error(rule_failed)
    members,approved,"invoice-doc-2" -> error(forbidden)
   examples seed=[test_worker,invoice_pdf,invoice_doc] order=purchase_order document=invoice_pdf source="invoice-doc-1"
    as -> count(InvoiceDocument)
    buyer -> error(rule_failed)
```

```can
   examples seed=[test_worker,invoice_doc] invoice_document=invoice_doc issued=date("2099-01-03")
    as,invoice_document.status,invoice,amount -> invoice_document.status,invoice_document.invoice,invoice_document.amount,count(InvoiceDocument)
    buyer,draft,"SUP-002",money(20,"EUR") -> transcribed,"SUP-002",money(20,"EUR"),1
    buyer,transcribed,"SUP-002",money(18,"EUR") -> transcribed,"SUP-002",money(18,"EUR"),1
    buyer,draft,"SUP-002",money(20,"USD") -> error(rule_failed)
    buyer,draft," ",money(20,"EUR") -> error(rule_failed)
    buyer,rejected,"SUP-002",money(20,"EUR") -> error(rule_failed)
    members,draft,"SUP-002",money(20,"EUR") -> error(forbidden)
   examples seed=[test_worker,accepted_doc] invoice_document=accepted_doc invoice="SUP-008" amount=money(10,"EUR") issued=date("2099-01-03")
    as -> invoice_document.status
    buyer -> error(rule_failed)
```

```can
   examples seed=[test_worker,invoice_doc] invoice_document=invoice_doc evidence="Filed supplier invoice"
    as,invoice_document.status,invoice_document.parent.state,invoice_document.parent.parent.actual,invoice,amount,issued,request.invoice_document.version -> count(Payable),result.invoice,invoice_document.status,invoice_document.payable==result
    budget_manager,transcribed,closed,money(20,"EUR"),"SUP-001",money(20,"EUR"),date("2099-01-03"),1 -> 1,"SUP-001",accepted,true
    budget_manager,transcribed,approved,money(20,"EUR"),"SUP-001",money(20,"EUR"),date("2099-01-03"),1 -> error(rule_failed)
    budget_manager,transcribed,closed,money(20,"EUR"),"SUP-001",money(19,"EUR"),date("2099-01-03"),1 -> error(rule_failed)
    budget_manager,transcribed,closed,money(20,"EUR"),"SUP-001",money(20,"EUR"),date("2099-01-04"),1 -> error(rule_failed)
    budget_manager,transcribed,closed,money(20,"EUR"),"SUP-001",money(21,"EUR"),date("2099-01-03"),1 -> error(rule_failed)
    budget_manager,transcribed,closed,money(20,"EUR"),"SUP-001",money(20,"USD"),date("2099-01-03"),1 -> error(rule_failed)
    budget_manager,draft,closed,money(20,"EUR"),"SUP-001",money(20,"EUR"),date("2099-01-03"),1 -> error(rule_failed)
    budget_manager,transcribed,closed,money(20,"EUR"),"SUP-001",money(20,"EUR"),date("2099-01-03"),2 -> error(conflict)
    members,transcribed,closed,money(20,"EUR"),"SUP-001",money(20,"EUR"),date("2099-01-03"),1 -> error(forbidden)
```

The `money(21,"EUR")` row fails on claim mismatch before affordability is reached; an over-affordable but exactly-transcribed amount fails on the affordability guard (required-cases row). The accepted row observes the link via reference-identity comparison against `result` (the created `Payable`).

```can
   examples seed=[test_worker,invoice_doc] invoice_document=invoice_doc
    as,invoice_document.status,reason -> invoice_document.status,invoice_document.decision,count(Payable)
    budget_manager,transcribed,"Totals do not match the order" -> rejected,"Totals do not match the order",0
    budget_manager,transcribed," " -> error(rule_failed)
    budget_manager,draft,"Totals do not match the order" -> error(rule_failed)
    members,transcribed,"Totals do not match the order" -> error(forbidden)
   examples seed=[test_worker,accepted_doc] invoice_document=accepted_doc reason="Late objection"
    as -> invoice_document.status
    budget_manager -> error(rule_failed)
```

Second-accept coverage (attach to `accept_invoice`):

```can
   examples seed=[test_worker,accepted_doc] invoice_document=accepted_doc invoice="SUP-008" amount=money(10,"EUR") issued=date("2099-01-03") evidence="Filed supplier invoice"
    as -> count(Payable)
    budget_manager -> error(rule_failed)
```

Expense — attach to `transcribe_receipt`:

```can
   examples seed=[test_worker] expense=claim source="extract-2" spent_on=date("2026-10-01") merchant="Station kiosk"
    as,expense.status,amount -> count(ReceiptExtract),result.source,result.amount
    self,draft,money(25,"EUR") -> 1,"extract-2",money(25,"EUR")
    self,draft,money(25,"USD") -> error(rule_failed)
    self,submitted,money(25,"EUR") -> error(rule_failed)
    ordinary_user,draft,money(25,"EUR") -> error(rule_failed)
   examples seed=[test_worker,receipt_extract] expense=claim source="extract-1" amount=money(25,"EUR") spent_on=date("2026-10-01") merchant="Station kiosk"
    as -> count(ReceiptExtract)
    self -> error(rule_failed)
```

Expense — `submit` deltas (D5): add `receipt_extract` to the seed lists of both existing `submit` isolated tables (`CanExpense.can:89,98`) and to the three existing `submit` shared-state sequences (`:103,115,137`) by inserting `call transcribe_receipt {expense=claim,source="extract-1",amount=money(25,"EUR"),spent_on=date("2026-10-01"),merchant="Station kiosk"} by=self` as the first call. All existing submit rows keep their expected outcomes. Add these two blocks (missing transcription; mismatched transcription via row-selector snapshot override):

```can
   examples seed=[reviewer_worker,ordinary_worker] expense=claim
    as,expense.reviewer,reviewer_worker.active,test_worker.active,request.expense.version -> expense.status
    self,reviewer_user,true,true,1 -> error(rule_failed)
   examples seed=[reviewer_worker,ordinary_worker,receipt_extract] expense=claim
    as,expense.reviewer,receipt_extract.amount -> expense.status
    self,reviewer_user,money(30,"EUR") -> error(rule_failed)
```

No other existing table or sequence invokes `submit` or changes draft claims, so `decide`, `withdraw`, `correct`, `reimburse`, `retain_legacy`, `legacy_matches`, and `link_legacy` examples are unaffected.

New expense shared-state sequence on `transcribe_receipt` (mismatch → correction → submission; uses existing fixtures only):

```can
   examples seed=[claim,reviewer_worker]
    do
     call transcribe_receipt {expense=claim,source="extract-9",amount=money(30,"EUR"),spent_on=date("2026-10-01"),merchant="Station kiosk"} by=self
     claim.status,count(claim.ReceiptExtract) -> draft,1
     call submit {expense=claim} by=self -> error(rule_failed)
     claim.status,count(claim.Decision) -> draft,0
     call transcribe_receipt {expense=claim,source="extract-10",amount=money(25,"EUR"),spent_on=date("2026-10-01"),merchant="Station kiosk"} by=self
     call submit {expense=claim} by=self
     claim.status,claim.submission,count(claim.ReceiptExtract) -> submitted,1,2
     call decide {expense=claim,approve=true,reason="Receipt and transcription checked"} by=reviewer_user
     claim.status,count(claim.Decision) -> approved,1
```

Desired JS for the added sequence descriptor (append to the existing flat `examples` array, DESIGN §13):

```js
{
  operation: "expense.transcribe_receipt",
  dependencies: [claim, reviewer_worker],
  sequence: [
    {
      operation: "expense.transcribe_receipt",
      by: async (c, s, b) => s.self,
      inputs: async (c, s, b) => ({ expense: s.claim, source: "extract-9", amount: money(30n, "EUR"), spent_on: date("2026-10-01"), merchant: "Station kiosk" }),
    },
    {
      observations: async (c, s, b) => [
        s.claim.status,
        await count(records(c, "expense.ReceiptExtract", { parent: s.claim })),
      ],
      expected: async (c, s, b) => ["draft", 1n],
      types: ["expense.Expense.status", "int"],
    },
    {
      operation: "expense.submit",
      by: async (c, s, b) => s.self,
      inputs: async (c, s, b) => ({ expense: s.claim }),
      error: "rule_failed",
    },
    {
      observations: async (c, s, b) => [
        s.claim.status,
        await count(records(c, "expense.Decision", { parent: s.claim })),
      ],
      expected: async (c, s, b) => ["draft", 0n],
      types: ["expense.Expense.status", "int"],
    },
    {
      operation: "expense.transcribe_receipt",
      by: async (c, s, b) => s.self,
      inputs: async (c, s, b) => ({ expense: s.claim, source: "extract-10", amount: money(25n, "EUR"), spent_on: date("2026-10-01"), merchant: "Station kiosk" }),
    },
    {
      operation: "expense.submit",
      by: async (c, s, b) => s.self,
      inputs: async (c, s, b) => ({ expense: s.claim }),
    },
    {
      observations: async (c, s, b) => [
        s.claim.status,
        s.claim.submission,
        await count(records(c, "expense.ReceiptExtract", { parent: s.claim })),
      ],
      expected: async (c, s, b) => ["submitted", 1n, 2n],
      types: ["expense.Expense.status", "int", "int"],
    },
    {
      operation: "expense.decide",
      by: async (c, s, b) => s.reviewer_user,
      inputs: async (c, s, b) => ({ expense: s.claim, approve: true, reason: "Receipt and transcription checked" }),
    },
    {
      observations: async (c, s, b) => [
        s.claim.status,
        await count(records(c, "expense.Decision", { parent: s.claim })),
      ],
      expected: async (c, s, b) => ["approved", 1n],
      types: ["expense.Expense.status", "int"],
    },
  ],
}
```

`money(25n,"EUR")`/`date("2026-10-01")` and seed-binding observations (`s.claim.status`, `parent: s.claim`) follow the existing expense descriptor spellings (`CanExpense.mjs:1044-1114`).

## Required cases

| Case | Expected outcome |
| --- | --- |
| Intake under approved or closed request | Draft document with frozen file and trimmed source |
| Duplicate document source (fresh operation) | `rule_failed`; first document unchanged |
| Same-operation intake retry | Runtime receipt replay returns the saved document (no new row) |
| Transcribe on draft/transcribed, order currency | Claims set, status transcribed; re-transcription corrects |
| Transcribe foreign currency / blank invoice / terminal status / wrong role | `rule_failed` / `forbidden`; stored claims unchanged |
| Accept with exact confirmed claims on closed, affordable spend | `Payable` created with document source; status accepted; link set; `export_payable` path unchanged |
| Accept before closure / claim mismatch / over-affordable / duplicate invoice / second accept | `rule_failed`; no `Payable`, no link, no partial status change |
| Accept with stale submitted version | `conflict`; nothing written |
| Accept by buyer/members; intake/transcribe by members | `forbidden` before body guards |
| Reject transcribed with reason | Status rejected, reason kept, file and claims retained, no `Payable` |
| Re-transcribe or accept after reject | `rule_failed` (terminal); correction uses fresh intake |
| Direct `record_payable` alongside documents | Unchanged; invoice uniqueness still rejects double evidence |
| Expense transcribe on others' / non-draft claim, duplicate source, wrong currency | `rule_failed`/`forbidden` as tabled; no row created |
| Submit without transcription or with only mismatched transcriptions | `rule_failed`; claim stays draft, no submission bump |
| Submit with one exact transcription among older mismatches | Succeeds; all transcription rows retained |
| Expense transcribe with stale version; submit with stale version | `conflict` (existing admission, unchanged mechanism) |
| Reviewer/finance read of extracts | Assigned-reviewer (non-draft) and finance grants only; colleagues see nothing (mirrors receipt privacy) |
| Generated CRUD on either new model | All three operations disabled (closed-world convention) |
| Budget/request/order/receipt/decision/reimbursement behavior | Unchanged; no existing guard, effect, grant, or outcome altered except the specified `submit` require |

## Advice, checks, and remaining limits

No JEV consultation was run for this handoff: the extension reuses settled file/money/version/delivery contracts and existing owners, and every new choice is flagged above for Codex review instead of advised by model vote. If Codex requires JEV for any D-choice, the three-request procedure applies before application.

Handoff verification: `node --check` on the assembled new JS witness blocks (wrapped with the existing import names); Can witness blocks use only precedented shapes with the citations above (no new syntax, no new builtin, no provider/adapter contract). These are snippet checks, not whole-target application.

Application checks: parse the non-sequence Can subset; `node --check` both entire desired targets; compare new Can/JS declaration schemas, guards/effects, money/date equality lowering, version-conflict rows, explicit page bindings, and every added sequence step. Confirm both new models have full-clause `disabled` entries and no generated CRUD. Report full runtime/privacy/UI/file-transfer checks as unexecuted. No broad corpus audit is requested.

Explicitly deferred: OCR/model extraction provider (D1), purchase shared-state sequence with new actor fixtures (D8), `record_payable`-linking for pre-existing payables, and any tolerance-based matching. The compiler, type checker, transaction engine, query budgets, file-transfer bridge, and BDD execution remain existing implementation gaps; this handoff does not close them.
