import { z } from 'zod';
import { listQuerySchema } from './api';
import { costInput, dateInput, moneyInput, optionalId, optionalText, positiveQtyInput } from './inputs';

const lineList = <T extends z.ZodType>(line: T) => z.array(line).min(1, 'Add at least one line').max(200);
const optionalDate = dateInput.optional().or(z.literal('').transform(() => undefined));

// ── Purchase orders ───────────────────────────────────────────────────────

export const poInputSchema = z.object({
  supplierId: z.uuid('Choose a supplier'),
  locationId: z.uuid('Choose the delivery location'),
  orderDate: dateInput,
  expectedDate: optionalDate,
  note: optionalText(1000),
  lines: lineList(
    z.object({
      variantId: z.uuid('Choose a product'),
      qty: positiveQtyInput,
      unitCost: costInput,
      taxRateId: optionalId,
    }),
  ),
});
export type PoInput = z.infer<typeof poInputSchema>;

// ── Goods receipts ────────────────────────────────────────────────────────

export const grnInputSchema = z.object({
  supplierId: z.uuid('Choose a supplier'),
  locationId: z.uuid('Choose the receiving location'),
  poId: optionalId,
  receivedDate: dateInput,
  supplierRef: optionalText(60),
  note: optionalText(1000),
  lines: lineList(
    z.object({
      poLineId: optionalId,
      variantId: z.uuid('Choose a product'),
      qty: positiveQtyInput,
      unitCost: costInput,
      taxRateId: optionalId,
      lotNumber: optionalText(60),
      mfgDate: optionalDate,
      expiryDate: optionalDate,
    }),
  ),
});
export type GrnInput = z.infer<typeof grnInputSchema>;

// ── Supplier invoices ─────────────────────────────────────────────────────

export const invoiceInputSchema = z.object({
  supplierId: z.uuid('Choose a supplier'),
  supplierRef: z.string().trim().min(1, "Enter the supplier's invoice number").max(60),
  invoiceDate: dateInput,
  dueDate: optionalDate,
  note: optionalText(1000),
  lines: lineList(
    z
      .object({
        grnLineId: optionalId,
        accountId: optionalId,
        description: optionalText(200),
        qty: positiveQtyInput,
        unitCost: costInput,
        taxRateId: optionalId,
      })
      .refine((l) => Boolean(l.grnLineId) !== Boolean(l.accountId), {
        message: 'Each line must match received goods or name an expense account',
        path: ['accountId'],
      }),
  ),
});
export type InvoiceInput = z.infer<typeof invoiceInputSchema>;

// ── Supplier payments ─────────────────────────────────────────────────────

export const paymentInputSchema = z
  .object({
    supplierId: z.uuid('Choose a supplier'),
    paymentDate: dateInput,
    amount: moneyInput.refine((v) => Number(v) > 0, 'Amount must be greater than zero'),
    accountId: z.uuid('Choose the account paid from'),
    reference: optionalText(80),
    note: optionalText(500),
    allocations: z
      .array(z.object({ invoiceId: z.uuid(), amount: moneyInput.refine((v) => Number(v) > 0, 'Must be greater than zero') }))
      .max(100)
      .default([]),
  })
  .refine((v) => new Set(v.allocations.map((a) => a.invoiceId)).size === v.allocations.length, {
    message: 'Each invoice can be allocated only once',
    path: ['allocations'],
  });
export type PaymentInput = z.infer<typeof paymentInputSchema>;

// ── Purchase returns ──────────────────────────────────────────────────────

export const purchaseReturnInputSchema = z.object({
  receiptId: z.uuid('Choose the goods receipt'),
  returnDate: dateInput,
  reason: optionalText(200),
  note: optionalText(1000),
  lines: lineList(z.object({ grnLineId: z.uuid(), qty: positiveQtyInput })),
});
export type PurchaseReturnInput = z.infer<typeof purchaseReturnInputSchema>;

export const purchaseListQuerySchema = listQuerySchema.extend({
  supplierId: z.uuid().optional(),
  status: z.string().max(30).optional(),
  from: dateInput.optional(),
  to: dateInput.optional(),
});

// ── Response shapes ───────────────────────────────────────────────────────

interface Ref {
  id: string;
  name: string;
}
interface VariantRef {
  id: string;
  sku: string;
  name: string;
  productName: string;
  isBatchTracked: boolean;
  isExpiryTracked: boolean;
}

export type PoStatus = 'DRAFT' | 'APPROVED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';

export interface PurchaseOrderSummary {
  id: string;
  number: string;
  supplier: Ref;
  location: Ref;
  status: PoStatus;
  orderDate: string;
  expectedDate: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  createdBy: string;
  createdAt: string;
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  note: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  endedBy: string | null;
  endedAt: string | null;
  lines: {
    id: string;
    lineNo: number;
    variant: VariantRef;
    qtyOrdered: string;
    qtyReceived: string;
    qtyOutstanding: string;
    unitCost: string;
    taxRateId: string | null;
    taxRate: string;
    netAmount: string;
  }[];
  receipts: { id: string; number: string; status: string; receivedDate: string; totalValue: string }[];
}

export interface GoodsReceiptSummary {
  id: string;
  number: string;
  supplier: Ref;
  location: Ref;
  po: { id: string; number: string } | null;
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  receivedDate: string;
  supplierRef: string | null;
  totalValue: string;
  createdBy: string;
  createdAt: string;
}

export interface GoodsReceiptDetail extends GoodsReceiptSummary {
  note: string | null;
  journalEntryId: string | null;
  postedBy: string | null;
  postedAt: string | null;
  lines: {
    id: string;
    lineNo: number;
    poLineId: string | null;
    variant: VariantRef;
    qty: string;
    unitCost: string;
    taxRateId: string | null;
    taxRate: string;
    lotNumber: string | null;
    mfgDate: string | null;
    expiryDate: string | null;
    value: string;
    qtyInvoiced: string;
    qtyReturned: string;
    /** Quantity still to be invoiced (received − invoiced − returned before invoicing). */
    qtyInvoiceable: string;
  }[];
}

/** A received-but-not-fully-invoiced line, offered when entering a supplier invoice. */
export interface OpenReceiptLine {
  grnLineId: string;
  receiptId: string;
  receiptNumber: string;
  receivedDate: string;
  variant: VariantRef;
  qtyInvoiceable: string;
  unitCost: string;
  taxRateId: string | null;
  taxRate: string;
}

export type InvoiceStatus = 'DRAFT' | 'POSTED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';

export interface SupplierInvoiceSummary {
  id: string;
  number: string;
  supplier: Ref;
  supplierRef: string;
  invoiceDate: string;
  dueDate: string;
  status: InvoiceStatus;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  outstanding: string;
  createdBy: string;
  createdAt: string;
}

export interface SupplierInvoiceDetail extends SupplierInvoiceSummary {
  note: string | null;
  journalEntryId: string | null;
  postedBy: string | null;
  postedAt: string | null;
  lines: {
    id: string;
    lineNo: number;
    grnLineId: string | null;
    receiptNumber: string | null;
    variant: VariantRef | null;
    account: { id: string; code: string; name: string } | null;
    description: string;
    qty: string;
    unitCost: string;
    taxRateId: string | null;
    taxRate: string;
    netAmount: string;
    taxAmount: string;
  }[];
  payments: { paymentId: string; number: string; paymentDate: string; amount: string }[];
}

export interface SupplierPaymentSummary {
  id: string;
  number: string;
  supplier: Ref;
  paymentDate: string;
  amount: string;
  unallocated: string;
  account: { id: string; code: string; name: string };
  reference: string | null;
  createdBy: string;
  createdAt: string;
}

export interface SupplierPaymentDetail extends SupplierPaymentSummary {
  note: string | null;
  journalEntryId: string;
  allocations: { invoiceId: string; number: string; supplierRef: string; amount: string }[];
}

export interface PurchaseReturnSummary {
  id: string;
  number: string;
  supplier: Ref;
  location: Ref;
  receipt: { id: string; number: string };
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  returnDate: string;
  creditTotal: string;
  createdBy: string;
  createdAt: string;
}

export interface PurchaseReturnDetail extends PurchaseReturnSummary {
  reason: string | null;
  note: string | null;
  journalEntryId: string | null;
  postedBy: string | null;
  postedAt: string | null;
  lines: {
    id: string;
    lineNo: number;
    grnLineId: string;
    variant: VariantRef;
    lotNumber: string | null;
    qty: string;
    stockValue: string;
    creditValue: string;
  }[];
}

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

export interface StatementLine {
  date: string;
  type: 'INVOICE' | 'PAYMENT' | 'RETURN';
  id: string;
  number: string;
  reference: string | null;
  /** Increases what we owe. */
  credit: string;
  /** Decreases what we owe. */
  debit: string;
  balance: string;
}

export interface SupplierStatement {
  supplier: Ref & { code: string; paymentTermsDays: number };
  from: string | null;
  to: string | null;
  openingBalance: string;
  lines: StatementLine[];
  closingBalance: string;
}

export interface PayablesAgingRow {
  supplier: Ref & { code: string };
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  over90: string;
  /** Payments not allocated to invoices and return credits (reduce the balance). */
  unappliedCredits: string;
  balance: string;
}
