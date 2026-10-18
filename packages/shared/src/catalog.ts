import { z } from 'zod';
import { listQuerySchema } from './api';
import { booleanQuery, costInput, moneyInput, optionalId, optionalText, qtyInput } from './inputs';

// ── Brands, categories, units ──────────────────────────────────────────────

export const brandInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: optionalText(500),
  isActive: z.boolean().default(true),
});
export const brandUpdateSchema = brandInputSchema.partial();

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  parentId: optionalId,
  description: optionalText(500),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});
export const categoryUpdateSchema = categoryInputSchema.partial();

export const unitInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{0,9}$/, 'Use 1–10 letters or digits, e.g. PC or ML'),
  name: z.string().trim().min(1).max(40),
  allowsFraction: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export const unitUpdateSchema = unitInputSchema.omit({ code: true }).partial();

export interface BrandSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  productCount: number;
}

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
}

export interface UnitSummary {
  id: string;
  code: string;
  name: string;
  allowsFraction: boolean;
  isActive: boolean;
}

// ── Products and variants ──────────────────────────────────────────────────

export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/, 'SKU: letters, digits, dot, dash or underscore (max 64)');

export const barcodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{4,64}$/, 'Barcode: 4–64 letters, digits or dashes');

export const variantInputSchema = z
  .object({
    sku: skuSchema,
    name: z.string().trim().min(1, 'Variant name is required').max(120),
    shade: optionalText(60),
    colour: optionalText(60),
    tone: optionalText(60),
    size: optionalText(40),
    volumeValue: qtyInput.optional().or(z.literal('').transform(() => undefined)),
    volumeUnitId: optionalId,
    sellingPrice: moneyInput,
    compareAtPrice: moneyInput.optional().or(z.literal('').transform(() => undefined)),
    standardCost: costInput.optional().or(z.literal('').transform(() => undefined)),
    reorderLevel: qtyInput.default('0'),
    reorderQty: qtyInput.default('0'),
    status: z.enum(['ACTIVE', 'DISCONTINUED']).default('ACTIVE'),
    barcodes: z.array(barcodeSchema).max(10).default([]),
  })
  .refine((v) => new Set(v.barcodes).size === v.barcodes.length, {
    message: 'Barcodes must be unique',
    path: ['barcodes'],
  });
export type VariantInput = z.infer<typeof variantInputSchema>;

export const variantUpdateSchema = z
  .object({
    sku: skuSchema,
    name: z.string().trim().min(1).max(120),
    shade: optionalText(60),
    colour: optionalText(60),
    tone: optionalText(60),
    size: optionalText(40),
    volumeValue: qtyInput.nullable(),
    volumeUnitId: optionalId,
    sellingPrice: moneyInput,
    compareAtPrice: moneyInput.nullable(),
    standardCost: costInput.nullable(),
    reorderLevel: qtyInput,
    reorderQty: qtyInput,
    status: z.enum(['ACTIVE', 'DISCONTINUED']),
    barcodes: z.array(barcodeSchema).max(10),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const productFields = {
  name: z.string().trim().min(1, 'Product name is required').max(160),
  brandId: optionalId,
  categoryId: optionalId,
  unitId: z.uuid('Choose a unit'),
  taxRateId: z.uuid('Choose a tax rate'),
  description: optionalText(5000),
  isBatchTracked: z.boolean().default(false),
  isExpiryTracked: z.boolean().default(false),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED']).default('ACTIVE'),
  onlineVisible: z.boolean().default(false),
};

export const productInputSchema = z
  .object({ ...productFields, variants: z.array(variantInputSchema).min(1, 'Add at least one variant').max(100) })
  .transform((v) => ({ ...v, isBatchTracked: v.isBatchTracked || v.isExpiryTracked }))
  .refine((v) => new Set(v.variants.map((x) => x.sku)).size === v.variants.length, {
    message: 'Each variant needs a different SKU',
    path: ['variants'],
  });
export type ProductInput = z.infer<typeof productInputSchema>;

export const productUpdateSchema = z
  .object(productFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export const productListQuerySchema = listQuerySchema.extend({
  brandId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED']).optional(),
  includeArchived: booleanQuery,
});

export const variantSearchQuerySchema = listQuerySchema.extend({
  locationId: z.uuid().optional(),
  activeOnly: booleanQuery,
});

export interface VariantDetail {
  id: string;
  productId: string;
  sku: string;
  name: string;
  shade: string | null;
  colour: string | null;
  tone: string | null;
  size: string | null;
  volumeValue: string | null;
  volumeUnit: { id: string; code: string } | null;
  sellingPrice: string;
  compareAtPrice: string | null;
  standardCost: string | null;
  avgCost: string;
  stockQty: string;
  stockValue: string;
  reorderLevel: string;
  reorderQty: string;
  status: 'ACTIVE' | 'DISCONTINUED';
  archived: boolean;
  barcodes: string[];
}

export interface ProductImageSummary {
  id: string;
  fileId: string;
  url: string;
  altText: string | null;
  variantId: string | null;
  sortOrder: number;
}

export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  status: 'DRAFT' | 'ACTIVE' | 'DISCONTINUED';
  brand: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  variantCount: number;
  priceMin: string | null;
  priceMax: string | null;
  stockQty: string;
  onlineVisible: boolean;
  archived: boolean;
  imageUrl: string | null;
}

export interface ProductDetail extends Omit<ProductSummary, 'variantCount' | 'priceMin' | 'priceMax' | 'stockQty' | 'imageUrl'> {
  description: string | null;
  unit: { id: string; code: string; name: string; allowsFraction: boolean };
  taxRate: { id: string; name: string; rate: string };
  isBatchTracked: boolean;
  isExpiryTracked: boolean;
  variants: VariantDetail[];
  images: ProductImageSummary[];
  createdAt: string;
  updatedAt: string;
}

/** Compact variant row for pickers and the POS. */
export interface VariantLookup {
  id: string;
  sku: string;
  name: string;
  productId: string;
  productName: string;
  brandName: string | null;
  sellingPrice: string;
  avgCost: string;
  isBatchTracked: boolean;
  isExpiryTracked: boolean;
  allowsFraction: boolean;
  unitCode: string;
  status: 'ACTIVE' | 'DISCONTINUED';
  productStatus: 'DRAFT' | 'ACTIVE' | 'DISCONTINUED';
  qtyOnHand: string | null;
  qtyAvailable: string | null;
  barcodes: string[];
  /** The product's default tax rate. */
  taxRateId: string;
  taxRate: string;
  standardCost: string | null;
}

// ── Suppliers ──────────────────────────────────────────────────────────────

export const supplierInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2–20 letters, digits or dashes')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  name: z.string().trim().min(1, 'Name is required').max(160),
  contactName: optionalText(120),
  email: z.union([z.literal('').transform(() => null), z.null(), z.email('Enter a valid email address')]).optional(),
  phone: optionalText(40),
  address: optionalText(500),
  taxId: optionalText(40),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  notes: optionalText(2000),
  isActive: z.boolean().default(true),
});
export const supplierUpdateSchema = supplierInputSchema
  .omit({ code: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const supplierListQuerySchema = listQuerySchema.extend({ includeInactive: booleanQuery });

export interface SupplierSummary {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  paymentTermsDays: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}
