# Accounting Rules

The rules every module follows when it posts to the general ledger. Implemented by the posting engine
([`apps/api/src/engines/posting/posting.service.ts`](../apps/api/src/engines/posting/posting.service.ts)); enforced again by database triggers (see [DATABASE.md](DATABASE.md)).

Status: the **engine, ledger guards, chart of accounts and periods are built (Phase 2)**. Posting rules marked *(Phase n)* are applied when that module is built.

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

## 4. Inventory costing — moving weighted-average cost (WAC) *(Phase 3)*

- WAC is maintained **per variant, company-wide**. Transfers between locations do not change cost.
- Inbound with cost (receipt, opening stock, positive adjustment, restocked return):
  `new_avg = (qty_on_hand × avg + qty_in × unit_cost_in) / (qty_on_hand + qty_in)`.
- Outbound (sale, write-off, negative adjustment, purchase return) is valued at the current average. The stock movement and the COGS/inventory journal lines use **the same figure**.
- Batches/lots drive FEFO picking and expiry control only; they carry no separate cost.
- Control: Σ(qty_on_hand × avg_cost) per the stock ledger = balance of `INVENTORY` (1200).

## 5. Posting rules

| Event | Debit | Credit |
|---|---|---|
| Goods received (GRN) *(Phase 4)* | Inventory (1200) at GRN cost | GRNI (2010) |
| Supplier invoice *(Phase 4)* | GRNI (matched value); VAT input (if recoverable); PPV (5030) if invoice > GRN | AP (2000); PPV if invoice < GRN |
| Supplier payment *(Phase 4)* | AP | Bank / Cash |
| Purchase return *(Phase 4)* | AP (or GRNI if not invoiced) | Inventory at WAC; difference to PPV |
| POS sale *(Phase 5)* | Cash (1000) / Card clearing (1020) / Bank (1010) per payment method; AR (1100) for an authorised credit balance | Sales revenue (4000) net of discounts; VAT output |
| …and its cost *(Phase 5)* | COGS (5000) at WAC | Inventory |
| Credit-sale receipt *(Phase 8)* | Cash / Bank | AR |
| **Online order — payment confirmed** *(Phase 7)* (revenue recognised at confirmation) | Gateway clearing (1030) / Bank | Sales revenue; Shipping income (4100); VAT output |
| …and its cost *(Phase 7)* | COGS at WAC | Inventory |
| Sales return + refund *(Phase 8)* | Sales returns (4010); VAT output | Cash / Bank / AR |
| …if restocked *(Phase 8)* | Inventory at the **original sale-line unit cost** | COGS |
| Online order cancelled after payment *(Phase 8)* | handled as a full return + refund | |
| Stock adjustment up / down *(Phase 3)* | Inventory / Shrinkage (5010) or Write-off (5020) | Inventory adjustments (5010) / Inventory |
| Stock transfer *(Phase 3)* | — no GL entry (same legal entity) — | |
| Expense *(Phase 8)* | Expense account; VAT input if recoverable | Cash / Bank (paid) or AP (on account) |
| Cash over / short at shift close *(Phase 8)* | Cash (over) / Cash over-short (4900) (short) | Cash over-short (over) / Cash (short) |
| Card settlement *(Phase 8)* | Bank; Bank charges (6050) | Card clearing |
| Opening balances *(Phase 6)* | each debit-balance account | Opening balance equity (3900) — and the reverse for credit balances |
| Year-end close *(Phase 6)* | income accounts | expense accounts; difference to Retained earnings (3100) |

Discounts are posted **net** (revenue is recorded after the line discount); the discount amount is stored on the sale for reporting.

## 6. Profit measures

- **Gross profit** = net sales (revenue − returns − discounts) − cost of goods sold (accounts with subtype `COGS`).
- **Net profit** = gross profit + other income − operating expenses (subtype `OPERATING_EXPENSE`).
- Both are computed from posted journal lines only.

## 7. Chart of accounts

Seeded from [`apps/api/prisma/seed/chart-of-accounts.ts`](../apps/api/prisma/seed/chart-of-accounts.ts). Accounts with a `system_key` are referenced by the posting rules above and must not be deleted or repurposed. Additional accounts can be added freely (Phase 6 UI).
