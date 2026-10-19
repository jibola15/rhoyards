import { z } from 'zod';
import { listQuerySchema } from './api';
import { booleanQuery, dateInput, moneyInput, optionalText, positiveQtyInput } from './inputs';

const positiveMoney = moneyInput.refine((v) => Number(v) > 0, 'Must be greater than zero');

// ── Customers ─────────────────────────────────────────────────────────────

export const customerInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160),
  type: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
  phone: optionalText(40),
  email: z.union([z.literal('').transform(() => null), z.null(), z.email('Enter a valid email address')]).optional(),
  address: optionalText(500),
  allowCredit: z.boolean().default(false),
  creditLimit: moneyInput.default('0'),
  notes: optionalText(2000),
  isActive: z.boolean().default(true),
});
export const customerUpdateSchema = customerInputSchema.partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export const customerListQuerySchema = listQuerySchema.extend({ includeInactive: booleanQuery });

export interface CustomerSummary {
  id: string;
  code: string;
  name: string;
  type: 'RETAIL' | 'WHOLESALE';
  phone: string | null;
  email: string | null;
  address: string | null;
  allowCredit: boolean;
  creditLimit: string;
  /** Amount owed on credit sales. */
  balance: string;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

// ── Payment methods & registers ───────────────────────────────────────────

export const paymentMethodInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'Use UPPER_SNAKE_CASE'),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'OTHER']),
  accountId: z.uuid('Choose the ledger account'),
  requiresReference: z.boolean().default(false),
  availablePos: z.boolean().default(true),
  availableOnline: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export const paymentMethodUpdateSchema = paymentMethodInputSchema.omit({ code: true }).partial();

export interface PaymentMethodSummary {
  id: string;
  code: string;
  name: string;
  kind: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';
  account: { id: string; code: string; name: string };
  requiresReference: boolean;
  availablePos: boolean;
  availableOnline: boolean;
  isActive: boolean;
  sortOrder: number;
}

export const registerInputSchema = z.object({
  locationId: z.uuid('Choose a location'),
  name: z.string().trim().min(1).max(60),
  isActive: z.boolean().default(true),
});
export const registerUpdateSchema = registerInputSchema.omit({ locationId: true }).partial();

export interface RegisterSummary {
  id: string;
  name: string;
  location: { id: string; name: string };
  isActive: boolean;
  openShift: { id: string; number: string; cashier: string; openedAt: string } | null;
}

// ── Shifts ────────────────────────────────────────────────────────────────

export const openShiftSchema = z.object({
  registerId: z.uuid('Choose a register'),
  openingFloat: moneyInput,
});
export const closeShiftSchema = z.object({
  countedCash: moneyInput,
  note: optionalText(500),
});

export interface ShiftSummary {
  id: string;
  number: string;
  status: 'OPEN' | 'CLOSED';
  register: { id: string; name: string; locationId: string; locationName: string };
  cashier: { id: string; name: string };
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  openingFloat: string;
  salesCount: number;
  salesTotal: string;
  discountTotal: string;
  taxTotal: string;
  creditTotal: string;
  byMethod: { methodId: string; name: string; kind: string; amount: string }[];
  /** Opening float + cash taken (net of change). */
  expectedCash: string;
  countedCash: string | null;
  variance: string | null;
  closeNote: string | null;
}

// ── Sales ─────────────────────────────────────────────────────────────────

export const saleLineInputSchema = z.object({
  variantId: z.uuid(),
  qty: positiveQtyInput,
  /** Shelf price per unit; must equal the catalogue price unless the cashier may override prices. */
  unitPrice: moneyInput,
  discount: z
    .object({ type: z.enum(['percent', 'amount']), value: moneyInput })
    .nullable()
    .optional(),
});

export const salePaymentInputSchema = z.object({
  paymentMethodId: z.uuid(),
  /** Amount applied to the sale. */
  amount: positiveMoney,
  /** Cash handed over (cash methods only); change = tendered − amount. */
  tendered: moneyInput.optional(),
  reference: optionalText(80),
});

export const saleInputSchema = z.object({
  registerId: z.uuid(),
  customerId: z.uuid().nullable().optional(),
  lines: z.array(saleLineInputSchema).min(1, 'The cart is empty').max(300),
  payments: z.array(salePaymentInputSchema).max(10).default([]),
  /** A supervisor's credentials, when discounts exceed the cashier's limit. */
  discountApproval: z.object({ email: z.string().trim().max(254), password: z.string().max(128) }).optional(),
  note: optionalText(500),
});
export type SaleInput = z.infer<typeof saleInputSchema>;

export const suspendSaleSchema = saleInputSchema.omit({ payments: true, discountApproval: true });

export const saleListQuerySchema = listQuerySchema.extend({
  from: dateInput.optional(),
  to: dateInput.optional(),
  shiftId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  channel: z.enum(['POS', 'ONLINE']).optional(),
});

export interface SaleSummary {
  id: string;
  number: string | null;
  channel: 'POS' | 'ONLINE';
  status: 'SUSPENDED' | 'COMPLETED';
  location: { id: string; name: string };
  register: { id: string; name: string } | null;
  customer: { id: string; name: string } | null;
  cashier: string;
  cashierId: string;
  total: string;
  balanceDue: string;
  itemCount: number;
  completedAt: string | null;
  createdAt: string;
}

export interface SaleDetail extends SaleSummary {
  pricesIncludeTax: boolean;
  shift: { id: string; number: string } | null;
  grossTotal: string;
  discountTotal: string;
  subtotal: string;
  taxTotal: string;
  amountPaid: string;
  changeGiven: string;
  costTotal: string;
  discountApprovedBy: string | null;
  note: string | null;
  journalEntryId: string | null;
  items: {
    id: string;
    lineNo: number;
    variantId: string;
    sku: string;
    description: string;
    qty: string;
    unitPrice: string;
    listPrice: string;
    discountAmount: string;
    taxRate: string;
    netAmount: string;
    taxAmount: string;
    lineTotal: string;
    unitCost: string;
    costAmount: string;
    qtyReturned: string;
  }[];
  payments: { id: string; method: { id: string; name: string; kind: string }; amount: string; tendered: string | null; changeGiven: string; reference: string | null }[];
}

export interface ReceiptData {
  business: { name: string; address: string; phone: string; email: string; taxId: string; vatRegistered: boolean };
  header: string;
  footer: string;
  currency: { code: string; symbol: string };
  sale: SaleDetail;
  /** VAT breakdown by rate. */
  taxSummary: { rate: string; net: string; tax: string }[];
}

/** Everything the till needs, without requiring settings.view. */
export interface PosContext {
  registers: RegisterSummary[];
  myShift: ShiftSummary | null;
  paymentMethods: PaymentMethodSummary[];
  pricing: { pricesIncludeTax: boolean; vatRegistered: boolean; maxDiscountPercent: string };
  inventory: { blockExpiredSale: boolean; allowNegativeStock: boolean };
  currency: { code: string; symbol: string };
}

/** A suspended sale's cart, returned on resume. */
export interface SuspendedCart {
  registerId: string | null;
  customer: { id: string; name: string } | null;
  note: string | null;
  lines: {
    variantId: string;
    sku: string;
    description: string;
    qty: string;
    unitPrice: string;
    listPrice: string;
    /** VAT rate recorded when parked (the sale is re-priced from the catalogue on completion). */
    taxRate: string;
    allowsFraction: boolean;
    discount: { type: 'percent' | 'amount'; value: string } | null;
  }[];
}
