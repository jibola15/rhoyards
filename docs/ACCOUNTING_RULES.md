# Accounting Rules

The rules every module follows when it posts to the general ledger. Implemented by the posting engine
([`apps/api/src/engines/posting/posting.service.ts`](../apps/api/src/engines/posting/posting.service.ts)); enforced again by database triggers (see [DATABASE.md](DATABASE.md)).

Status: the **engine, ledger guards, chart of accounts and periods are built (Phase 2)**; **inventory costing, stock adjustments and transfers are built (Phase 3)**; **purchasing — receipts, supplier invoices, payments and returns — is built (Phase 4)**; **POS sales and shift close are built (Phase 5)**. Posting rules marked *(Phase n)* for later phases are applied when that module is built.

## 1. Fundamentals

- **Double entry.** Every journal entry has ≥ 2 lines and Σdebit = Σcredit > 0. Each line is either a debit or a credit, never both.
- **Immutability.** Posted entries and their lines cannot be edited or deleted. Errors are corrected by a **reversal** (mirror entry, linked by `reversal_of_id`, at most one per entry) followed by a correct replacement entry.
- **No double posting.** Automatic postings carry a `posting_key` (e.g. `SALE:<id>`, `GRN:<id>`). Posting the same key again returns the existing entry.
- **Atomicity.** Postings happen inside the same database transaction as the business document and stock movements. If any step fails, nothing is posted.
- **Periods.** An entry must fall inside an `OPEN` accounting period. Closed periods reject postings; corrections go into an open period.
- **Numbering.** Posted entries are numbered `JE-000001…` without gaps (sequence row locked inside the transaction).
- **Currency.** Single currency, NGN by default (setting). No foreign-currency postings in v1.

## 2. Money and rounding

- All arithmetic uses `Decimal` (decimal.js) — never JavaScript `number`. The API transmits money as strings.
- Amounts are rounded **half-up to 2 dp at line level**; document totals are sums of rounded lines.
- Unit and average costs are kept to 4 dp; quantities to 3 dp.

## 3. VAT

The business is VAT-registered. Configuration:

- `pricing.pricesIncludeTax` (setting, Owner/Accountant): **true** — the selling price includes VAT, and VAT is extracted as `tax = round(gross × rate / (100 + rate))`, `net = gross − tax`; **false** — VAT is added on top: `tax = round(net × rate / 100)`.
- Each product carries a tax rate: standard (default 7.5 %, editable), zero-rated or exempt. The rate is **snapshotted on each sale line**, so changing a rate affects new transactions only.
- Output VAT is credited to `VAT_OUTPUT` (2100). Recoverable input VAT on purchases/expenses is debited to `VAT_INPUT` (2110); whether input VAT is recoverable is decided per transaction type, not assumed.

## 4. Inventory costing — moving weighted-average cost (WAC) *(built in Phase 3)*

- WAC is maintained **per variant, company-wide**, by holding the variant's total quantity (`stock_qty`) and total value (`stock_value`). Transfers between locations do not change cost or value.
- Inbound with cost (receipt, opening stock, positive adjustment, restocked return): value in = round₂(qty × unit cost); `stock_value += value in`; `avg_cost = round₄(stock_value / stock_qty)`.
- Outbound (sale, write-off, negative adjustment, purchase return) is valued at the current average: cost = round₂(qty × avg_cost) — **except** when the issue empties the variant, in which case cost = the remaining `stock_value` exactly, so rounding never accumulates. The stock movement and the journal lines use **the same figure**.
- Batches/lots drive FEFO picking and expiry control only; they carry no separate cost.
- Control: Σ `stock_value` = balance of `INVENTORY` (1200); exposed at `GET /inventory/valuation` and shown on the Stock levels screen.
- Negative stock is refused unless the `inventory.allowNegativeStock` setting is on **and** the user holds `stock.negative.allow`; it is never allowed for batch-tracked items. Issues while stock is at or below zero are costed at the last average.

### Stock adjustments *(built in Phase 3)*

| Reason | Increase (Dr Inventory / Cr …) | Decrease (Dr … / Cr Inventory) | Movement type |
|---|---|---|---|
| Opening stock | Opening balance equity (3900) | — (not allowed) | `OPENING` |
| Stock count correction | Inventory adjustments (5010) | Inventory adjustments (5010) | `ADJUSTMENT_IN` / `ADJUSTMENT_OUT` |
| Theft / loss | — (not allowed) | Inventory adjustments (5010) | `ADJUSTMENT_OUT` |
| Damaged, Expired | — (not allowed) | Stock write-off (5020) | `WRITE_OFF` |
| Other | Inventory adjustments (5010) | Inventory adjustments (5010) | `ADJUSTMENT_IN` / `ADJUSTMENT_OUT` |

Adjustments are created as drafts (`inventory.adjust`) and posted (`inventory.adjust.approve`); posting moves stock and posts one journal (`posting_key = STOCK_ADJUSTMENT:<id>`) in a single transaction. Decreases may take expired lots (they correct reality); sales will not when expired sales are blocked.

### Stock transfers *(built in Phase 3)*

Dispatch removes stock (FEFO; expired lots are not sent) from the source; receipt recreates the same lots at the destination. No journal entry: the value stays in Inventory throughout, and quantity in transit is reported by the valuation endpoint.

## 5. Posting rules

| Event | Debit | Credit |
|---|---|---|
| Goods received (GRN) *(built — §5a)* | Inventory (1200) at GRN cost | GRNI (2010) |
| Supplier invoice *(built — §5a)* | GRNI (matched value); expense lines; VAT input; PPV (5030) if invoice > GRN | AP (2000); PPV if invoice < GRN |
| Supplier payment *(built)* | AP | Bank / Cash |
| Purchase return *(built — §5a)* | GRNI (uninvoiced part); AP (invoiced part incl. VAT) | Inventory at WAC; VAT input; difference to PPV |
| POS sale *(built — §5b)* | Cash (1000) / Card clearing (1020) / Bank (1010) per payment method; AR (1100) for an authorised credit balance | Sales revenue (4000) net of discounts; VAT output |
| …and its cost *(built)* | COGS (5000) at WAC | Inventory |
| Credit-sale receipt *(Phase 8)* | Cash / Bank | AR |
| **Online order — payment confirmed** *(Phase 7)* (revenue recognised at confirmation) | Gateway clearing (1030) / Bank | Sales revenue; Shipping income (4100); VAT output |
| …and its cost *(Phase 7)* | COGS at WAC | Inventory |
| Sales return + refund *(Phase 8)* | Sales returns (4010); VAT output | Cash / Bank / AR |
| …if restocked *(Phase 8)* | Inventory at the **original sale-line unit cost** | COGS |
| Online order cancelled after payment *(Phase 8)* | handled as a full return + refund | |
| Stock adjustment *(built — see §4)* | Inventory, or Adjustments (5010) / Write-off (5020) | Opening balance equity / Adjustments, or Inventory |
| Stock transfer *(built)* | — no GL entry (same legal entity) — | |
| Expense *(Phase 8)* | Expense account; VAT input if recoverable | Cash / Bank (paid) or AP (on account) |
| Cash over / short at shift close *(built — §5b)* | Cash (over) / Cash over-short (4900) (short) | Cash over-short (over) / Cash (short) |
| Card settlement *(Phase 8)* | Bank; Bank charges (6050) | Card clearing |
| Opening balances *(Phase 6)* | each debit-balance account | Opening balance equity (3900) — and the reverse for credit balances |
| Year-end close *(Phase 6)* | income accounts | expense accounts; difference to Retained earnings (3100) |

Discounts are posted **net** (revenue is recorded after the line discount); the discount amount is stored on the sale for reporting.

## 5a. Purchasing in detail *(built in Phase 4)*

Purchase prices are **exclusive of VAT**. Stock is valued at the net cost; VAT on supplier invoices is recoverable input VAT (the business is VAT-registered).

**Three-way match (order → receipt → invoice).**
- Receiving goods (GRN) books Dr Inventory / Cr GRNI at the receipt cost, per line `value = round₂(qty × cost)`. Receipts against an order may be partial; receiving more than is outstanding is refused under row locks.
- A supplier invoice line either matches received goods or charges an expense/prepayment account (delivery, services). For a matched line: GRNI cleared = round₂(qty × receipt cost) — or, when the invoice completes the line, exactly the GRNI still outstanding; the invoiced net minus the GRNI cleared goes to Purchase price variance (5030). VAT input = round₂(net × rate) per line. The invoice credits AP with its total.
- The same goods cannot be invoiced twice (matched quantities are recorded on the receipt line under a row lock; CHECK `qty_invoiced + qty_returned_uninvoiced ≤ qty`), and the same supplier invoice number cannot be entered twice for a supplier.
- Expense lines carry VAT only when a rate is chosen.

**Payments.** Dr AP / Cr the chosen cash or bank account. A payment may be applied to several invoices (never beyond an invoice's outstanding amount, enforced under row locks); any remainder stays as a credit with the supplier. Payments are immutable; the API requires an `Idempotency-Key` so a retried request cannot pay twice.

**Returns to supplier** are made against the goods receipt the stock arrived on and use that line's lot. Stock leaves at the moving average (Cr Inventory). The quantity not yet invoiced is returned first and clears GRNI at the receipt cost; quantity already invoiced raises a debit note at the average invoiced price: Dr AP (net + VAT), Cr VAT input. Any difference between what is cleared/credited and the stock value goes to Purchase price variance.

**What we owe a supplier** = posted invoices − payments − return credits (debit notes). Unapplied payments and return credits are shown as credits on the aged-payables report.

**Controls (tested):** AP ledger balance = Σ supplier balances; GRNI ledger balance = Σ (receipt line value − GRNI cleared) over posted receipts; Inventory ledger balance = stock ledger value.

## 5b. POS sales in detail *(built in Phase 5)*

**Pricing** (`priceSale` in `packages/shared`, used by both the till and the API). Per line: gross = round₂(qty × unit price); discount = round₂(gross × pct ÷ 100) or a fixed amount ≤ gross; after = gross − discount. Prices include VAT: tax = round₂(after × r ÷ (100 + r)), net = after − tax. Prices exclude VAT: net = after, tax = round₂(net × r ÷ 100). Tax is charged only while the business is VAT-registered. The sale stores gross, discount, net (subtotal), tax and total; a database CHECK keeps them consistent.

**Completing a sale** is one database transaction, idempotent per `Idempotency-Key`: validate and price → check price-override and discount authority → record payments → issue stock (FEFO, moving average; expired lots blocked when `blockExpiredSale` is on) → post **one** journal (`posting_key = SALE:<id>`):

| Debit | Credit |
|---|---|
| each payment method's ledger account (Cash 1000, Card clearing 1020, Bank 1010 …), summed per account | Sales revenue (4000) = Σ net |
| AR (1100) for any unpaid balance — only for a customer with credit enabled, within available credit, by a user with `pos.credit_sale` | VAT output (2100) = Σ tax |
| COGS (5000) at the issue cost | Inventory (1200) |

Payments may not add up to more than the total; change is given only on cash (tendered = amount + change). Any failure rolls back everything (sale, stock movements, journal). Completed sales, their lines and payments are immutable (database guards); returns (Phase 8) only advance `qty_returned`.

**Shift close.** Expected cash = opening float + cash taken (net of change). The difference from the counted cash posts `posting_key = CASHIER_SHIFT:<id>:VARIANCE`: over → Dr Cash / Cr Cash over-short (4900); short → the reverse. Closed shifts are final.

**Journal date** is the business day in `BUSINESS_TIMEZONE`.

**Controls (tested):** Inventory ledger = stock ledger value; AR ledger = Σ customer balances.

## 6. Profit measures

- **Gross profit** = net sales (revenue − returns − discounts) − cost of goods sold (accounts with subtype `COGS`).
- **Net profit** = gross profit + other income − operating expenses (subtype `OPERATING_EXPENSE`).
- Both are computed from posted journal lines only.

## 7. Chart of accounts

Seeded from [`apps/api/prisma/seed/chart-of-accounts.ts`](../apps/api/prisma/seed/chart-of-accounts.ts). Accounts with a `system_key` are referenced by the posting rules above and must not be deleted or repurposed. Additional accounts can be added freely (Phase 6 UI).
