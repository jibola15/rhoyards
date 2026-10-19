import { z } from 'zod';
import { listQuerySchema } from './api';
import { dateInput, moneyInput, optionalId, optionalText, positiveQtyInput } from './inputs';

// ── Sales returns and refunds ─────────────────────────────────────────────

export const ITEM_CONDITIONS = ['RESALEABLE', 'OPENED', 'DAMAGED', 'EXPIRED'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];
export const CONDITION_LABELS: Record<ItemCondition, string> = {
  RESALEABLE: 'As new (back to stock)',
  OPENED: 'Opened',
  DAMAGED: 'Damaged',
  EXPIRED: 'Expired',
};

export const RETURN_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'REJECTED'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const returnInputSchema = z.object({
  saleId: z.uuid(),
  reason: z.string().trim().min(3, 'Give the reason for the return').max(300),
  lines: z
    .array(
      z.object({
        saleItemId: z.uuid(),
        qty: positiveQtyInput,
        condition: z.enum(ITEM_CONDITIONS),
        /** Back into stock at the original cost. Only resaleable items can be restocked. */
        restock: z.boolean(),
      }),
    )
    .min(1, 'Choose at least one item')
    .max(200)
    .refine((ls) => ls.every((l) => !l.restock || l.condition === 'RESALEABLE'), { message: 'Only resaleable items can go back to stock' }),
  /** Online sales only: also refund the delivery charge. */
  refundShipping: z.boolean().default(false),
  /** Approve straight away (requires returns.approve). */
  approve: z.boolean().default(false),
});
export type ReturnInput = z.infer<typeof returnInputSchema>;

export const rejectReturnSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

export const refundInputSchema = z.object({
  /** How any amount not set against the customer's account is paid back. */
  paymentMethodId: optionalId,
  reference: optionalText(80),
});

export const returnListQuerySchema = listQuerySchema.extend({
  status: z.enum(RETURN_STATUSES).optional(),
  saleId: z.uuid().optional(),
});

export interface ReturnSummary {
  id: string;
  number: string;
  status: ReturnStatus;
  sale: { id: string; number: string; channel: 'POS' | 'ONLINE' };
  customer: { id: string; name: string } | null;
  total: string;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
}

export interface ReturnDetail extends ReturnSummary {
  reason: string;
  rejectedReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  completedBy: string | null;
  lines: {
    id: string;
    saleItemId: string;
    sku: string;
    description: string;
    qty: string;
    condition: ItemCondition;
    restock: boolean;
    net: string;
    tax: string;
    total: string;
    unitCost: string;
  }[];
  shippingNet: string;
  shippingTax: string;
  net: string;
  tax: string;
  /** Set against what the customer still owed on the sale. */
  creditedToAccount: string;
  /** Paid back to the customer. */
  paidOut: string;
  refundMethod: { id: string; name: string } | null;
  refundReference: string | null;
  journalEntryId: string | null;
  /** What the sale has left to return (for a new return). */
}

/** What can still be returned from a sale, per line. */
export interface ReturnableSale {
  sale: { id: string; number: string; channel: 'POS' | 'ONLINE'; customer: { id: string; name: string } | null; completedAt: string; outstanding: string };
  lines: { saleItemId: string; sku: string; description: string; qty: string; returnable: string; unitPrice: string; lineTotal: string }[];
  shippingRefundable: string;
}

// ── Customer receipts (payments against credit sales) ─────────────────────

export const customerReceiptSchema = z
  .object({
    customerId: z.uuid(),
    receiptDate: dateInput,
    paymentMethodId: z.uuid('Choose how the customer paid'),
    amount: moneyInput.refine((v) => Number(v) > 0, 'Enter an amount greater than zero'),
    reference: optionalText(80),
    note: optionalText(500),
    allocations: z.array(z.object({ saleId: z.uuid(), amount: moneyInput })).max(200).default([]),
  })
  .refine((r) => r.allocations.every((a) => Number(a.amount) > 0), { message: 'Allocated amounts must be greater than zero', path: ['allocations'] });
export type CustomerReceiptInput = z.infer<typeof customerReceiptSchema>;

export interface OpenCreditSale {
  id: string;
  number: string;
  date: string;
  total: string;
  outstanding: string;
}

export interface CustomerReceiptDetail {
  id: string;
  number: string;
  customer: { id: string; name: string };
  receiptDate: string;
  method: { id: string; name: string };
  amount: string;
  unallocated: string;
  reference: string | null;
  note: string | null;
  allocations: { saleId: string; number: string; amount: string }[];
  createdBy: string;
  createdAt: string;
}

export interface CustomerStatement {
  customer: { id: string; code: string; name: string; creditLimit: string; allowCredit: boolean };
  lines: { date: string; type: 'SALE' | 'RECEIPT' | 'RETURN'; id: string; number: string; debit: string; credit: string; balance: string }[];
  balance: string;
  openSales: OpenCreditSale[];
  unappliedCredit: string;
}

// ── Expenses ──────────────────────────────────────────────────────────────

export const EXPENSE_STATUSES = ['DRAFT', 'SUBMITTED', 'POSTED'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const expenseCategorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  accountId: z.uuid('Choose the expense account'),
  isActive: z.boolean().default(true),
});

export interface ExpenseCategoryRow {
  id: string;
  name: string;
  account: { id: string; code: string; name: string };
  isActive: boolean;
}

export const expenseInputSchema = z.object({
  expenseDate: dateInput,
  categoryId: z.uuid('Choose a category'),
  payee: z.string().trim().min(2, 'Who was paid?').max(120),
  description: z.string().trim().min(2, 'Describe the expense').max(300),
  /** What was paid, VAT included. */
  total: moneyInput.refine((v) => Number(v) > 0, 'Enter an amount greater than zero'),
  /** Recoverable VAT included in the total (a VAT invoice was received). */
  taxRateId: optionalId,
  paymentAccountId: z.uuid('Choose where it was paid from'),
  reference: optionalText(80),
  attachmentIds: z.array(z.uuid()).max(10).default([]),
});
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

export const expenseListQuerySchema = listQuerySchema.extend({
  status: z.enum(EXPENSE_STATUSES).optional(),
  categoryId: z.uuid().optional(),
  from: dateInput.optional(),
  to: dateInput.optional(),
});

export interface ExpenseSummary {
  id: string;
  number: string;
  expenseDate: string;
  category: string;
  payee: string;
  description: string;
  total: string;
  status: ExpenseStatus;
  createdBy: string;
}

export interface ExpenseDetail extends ExpenseSummary {
  createdById: string;
  categoryId: string;
  account: { id: string; code: string; name: string };
  paymentAccount: { id: string; code: string; name: string };
  taxRate: { id: string; name: string; rate: string } | null;
  net: string;
  tax: string;
  reference: string | null;
  rejectedReason: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  postedAt: string | null;
  journalEntryId: string | null;
  attachments: { id: string; url: string; name: string; mimeType: string }[];
}

// ── Bank and cash reconciliation ──────────────────────────────────────────

export const reconciliationStartSchema = z.object({
  accountId: z.uuid('Choose the bank or cash account'),
  statementDate: dateInput,
  /** Closing balance on the statement (a debit balance is positive). */
  statementBalance: z.string().trim().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'Enter the statement balance'),
});
export const reconciliationLinesSchema = z.object({ cleared: z.array(z.uuid()).max(5000) });

export interface ReconciliationSummary {
  id: string;
  account: { id: string; code: string; name: string };
  statementDate: string;
  statementBalance: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  completedAt: string | null;
  completedBy: string | null;
}

export interface ReconciliationDetail extends ReconciliationSummary {
  openingBalance: string;
  clearedBalance: string;
  difference: string;
  lines: { journalLineId: string; entryId: string; number: string; date: string; description: string; memo: string | null; debit: string; credit: string; cleared: boolean }[];
}

export const settlementSchema = z.object({
  settlementDate: dateInput,
  clearingAccountId: z.uuid('Choose the clearing account'),
  bankAccountId: z.uuid('Choose the bank account'),
  /** Gross amount settled out of clearing. */
  amount: moneyInput.refine((v) => Number(v) > 0, 'Enter an amount greater than zero'),
  /** Charges deducted by the bank or gateway. */
  fees: moneyInput,
  reference: optionalText(80),
});
