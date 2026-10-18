import { z } from 'zod';
import { barcodeSchema, costInput, moneyInput, qtyInput, skuSchema, type VariantDetail } from '@rhoyards/shared';

const blankOr = <T extends z.ZodType>(schema: T) => z.union([z.literal(''), schema]);

/** Form shape for one variant: every field is a string so inputs stay controlled. */
export const variantFormSchema = z
  .object({
    sku: skuSchema,
    name: z.string().trim().min(1, 'Variant name is required').max(120),
    shade: z.string().trim().max(60),
    colour: z.string().trim().max(60),
    tone: z.string().trim().max(60),
    size: z.string().trim().max(40),
    volumeValue: blankOr(qtyInput),
    volumeUnitId: z.string(),
    sellingPrice: moneyInput,
    compareAtPrice: blankOr(moneyInput),
    standardCost: blankOr(costInput),
    reorderLevel: qtyInput,
    reorderQty: qtyInput,
    status: z.enum(['ACTIVE', 'DISCONTINUED']),
    barcodesText: z.string().max(700),
  })
  .superRefine((v, ctx) => {
    const codes = splitBarcodes(v.barcodesText);
    for (const code of codes) {
      if (!barcodeSchema.safeParse(code).success) {
        ctx.addIssue({ code: 'custom', path: ['barcodesText'], message: `"${code}" is not a valid barcode (4–64 letters, digits or dashes)` });
        return;
      }
    }
    if (new Set(codes).size !== codes.length) ctx.addIssue({ code: 'custom', path: ['barcodesText'], message: 'A barcode is listed twice' });
  });
export type VariantFormValues = z.infer<typeof variantFormSchema>;

export function splitBarcodes(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const emptyVariant = (): VariantFormValues => ({
  sku: '',
  name: '',
  shade: '',
  colour: '',
  tone: '',
  size: '',
  volumeValue: '',
  volumeUnitId: '',
  sellingPrice: '',
  compareAtPrice: '',
  standardCost: '',
  reorderLevel: '0',
  reorderQty: '0',
  status: 'ACTIVE',
  barcodesText: '',
});

const trimZeros = (v: string | null) => (v === null ? '' : v.includes('.') ? v.replace(/\.?0+$/, '') : v);

export const variantToForm = (v: VariantDetail): VariantFormValues => ({
  sku: v.sku,
  name: v.name,
  shade: v.shade ?? '',
  colour: v.colour ?? '',
  tone: v.tone ?? '',
  size: v.size ?? '',
  volumeValue: trimZeros(v.volumeValue),
  volumeUnitId: v.volumeUnit?.id ?? '',
  sellingPrice: v.sellingPrice,
  compareAtPrice: v.compareAtPrice ?? '',
  standardCost: trimZeros(v.standardCost),
  reorderLevel: trimZeros(v.reorderLevel),
  reorderQty: trimZeros(v.reorderQty),
  status: v.status,
  barcodesText: v.barcodes.join(', '),
});

/** Converts form values to the API payload; blank optional fields are sent as null (= clear). */
export function variantPayload(v: VariantFormValues) {
  const blank = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    sku: v.sku,
    name: v.name,
    shade: blank(v.shade),
    colour: blank(v.colour),
    tone: blank(v.tone),
    size: blank(v.size),
    volumeValue: blank(v.volumeValue),
    volumeUnitId: blank(v.volumeUnitId),
    sellingPrice: v.sellingPrice,
    compareAtPrice: blank(v.compareAtPrice),
    standardCost: blank(v.standardCost),
    reorderLevel: v.reorderLevel,
    reorderQty: v.reorderQty,
    status: v.status,
    barcodes: splitBarcodes(v.barcodesText),
  };
}
