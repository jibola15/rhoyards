import { z } from 'zod';
import { listQuerySchema } from './api';
import { booleanQuery, costInput, dateInput, optionalText, positiveQtyInput, signedQtyInput } from './inputs';

export const ADJUSTMENT_REASONS = ['OPENING_STOCK', 'STOCK_COUNT', 'DAMAGE', 'EXPIRY', 'THEFT', 'OTHER'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  OPENING_STOCK: 'Opening stock',
  STOCK_COUNT: 'Stock count correction',
  DAMAGE: 'Damaged',
  EXPIRY: 'Expired',
  THEFT: 'Theft / loss',
  OTHER: 'Other',
};

export const adjustmentLineInputSchema = z.object({
  variantId: z.uuid('Choose a product'),
  qtyChange: signedQtyInput,
  unitCost: costInput.optional().or(z.literal('').transform(() => undefined)),
  lotNumber: z
    .string()
    .trim()
    .max(60)
    .transform((v) => (v ? v : undefined))
    .optional(),
  mfgDate: dateInput.optional().or(z.literal('').transform(() => undefined)),
  expiryDate: dateInput.optional().or(z.literal('').transform(() => undefined)),
  note: optionalText(300),
});
export type AdjustmentLineInput = z.infer<typeof adjustmentLineInputSchema>;

export const adjustmentInputSchema = z
  .object({
    locationId: z.uuid('Choose a location'),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: optionalText(1000),
    lines: z.array(adjustmentLineInputSchema).min(1, 'Add at least one line').max(200),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((line, i) => {
      const increase = !line.qtyChange.startsWith('-');
      if (increase && line.unitCost === undefined) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'unitCost'], message: 'Unit cost is required when adding stock' });
      }
      if (!increase && (v.reason === 'OPENING_STOCK')) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'qtyChange'], message: 'Opening stock can only add quantities' });
      }
      if (increase && (v.reason === 'DAMAGE' || v.reason === 'EXPIRY' || v.reason === 'THEFT')) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'qtyChange'], message: 'This reason can only remove stock' });
      }
    });
  });
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

export const transferInputSchema = z
  .object({
    fromLocationId: z.uuid('Choose the source location'),
    toLocationId: z.uuid('Choose the destination location'),
    note: optionalText(1000),
    lines: z
      .array(z.object({ variantId: z.uuid('Choose a product'), qty: positiveQtyInput }))
      .min(1, 'Add at least one line')
      .max(200),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    message: 'Source and destination must differ',
    path: ['toLocationId'],
  });
export type TransferInput = z.infer<typeof transferInputSchema>;

export const documentListQuerySchema = listQuerySchema.extend({
  status: z.string().max(20).optional(),
  locationId: z.uuid().optional(),
});

export const stockQuerySchema = listQuerySchema.extend({
  locationId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  lowStock: booleanQuery,
});

export const movementQuerySchema = listQuerySchema.omit({ sort: true }).extend({
  variantId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  type: z.string().max(30).optional(),
  from: dateInput.optional(),
  to: dateInput.optional(),
});

export const batchQuerySchema = listQuerySchema.omit({ sort: true }).extend({
  variantId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  /** Batches expiring on or before today + N days (already-expired included). */
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
});

export interface StockRow {
  variantId: string;
  sku: string;
  variantName: string;
  productId: string;
  productName: string;
  brandName: string | null;
  categoryName: string | null;
  unitCode: string;
  qtyOnHand: string;
  qtyReserved: string;
  qtyAvailable: string;
  reorderLevel: string;
  avgCost: string;
  /** Company-wide stock value of this variant (from the stock ledger). */
  stockValue: string;
  isLowStock: boolean;
}

export interface MovementRow {
  id: string;
  createdAt: string;
  type: string;
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  location: { id: string; code: string; name: string };
  lotNumber: string | null;
  qtyChange: string;
  unitCost: string;
  totalCost: string;
  qtyAfter: string;
  sourceType: string;
  sourceId: string;
  reference: string | null;
  createdBy: string;
  note: string | null;
}

export interface BatchRow {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  location: { id: string; code: string; name: string };
  lotNumber: string;
  mfgDate: string | null;
  expiryDate: string | null;
  qtyOnHand: string;
  daysToExpiry: number | null;
  isExpired: boolean;
}

export interface AdjustmentSummary {
  id: string;
  number: string;
  location: { id: string; name: string };
  reason: AdjustmentReason;
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  lineCount: number;
  totalValue: string | null;
  createdBy: string;
  createdAt: string;
  postedAt: string | null;
}

export interface AdjustmentDetail extends AdjustmentSummary {
  note: string | null;
  journalEntryId: string | null;
  postedBy: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  lines: {
    id: string;
    lineNo: number;
    variant: { id: string; sku: string; name: string; productName: string; isBatchTracked: boolean; isExpiryTracked: boolean };
    qtyChange: string;
    unitCost: string | null;
    lotNumber: string | null;
    mfgDate: string | null;
    expiryDate: string | null;
    note: string | null;
    /** Posted value (from the stock movements) — null while draft. */
    postedValue: string | null;
  }[];
}

export interface TransferSummary {
  id: string;
  number: string;
  fromLocation: { id: string; name: string };
  toLocation: { id: string; name: string };
  status: 'DRAFT' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';
  lineCount: number;
  createdBy: string;
  createdAt: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
}

export interface TransferDetail extends TransferSummary {
  note: string | null;
  lines: {
    id: string;
    lineNo: number;
    variant: { id: string; sku: string; name: string; productName: string };
    qty: string;
    batches: { lotNumber: string; expiryDate: string | null; qty: string }[];
  }[];
}
