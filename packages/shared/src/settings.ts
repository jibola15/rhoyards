import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).optional().default('');

/** Each top-level key is stored as one row in the `settings` table. */
export const settingsSchema = z.object({
  business: z.object({
    name: z.string().trim().min(1, 'Business name is required').max(120),
    address: optionalText(300),
    phone: optionalText(40),
    email: z.union([z.literal(''), z.email('Enter a valid email address')]).default(''),
    taxId: optionalText(40),
    vatRegistered: z.boolean().default(true),
  }),
  currency: z.object({
    code: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code'),
    symbol: z.string().trim().min(1).max(5),
  }),
  pricing: z.object({
    /** true: shelf prices include VAT (VAT is extracted); false: VAT is added on top. */
    pricesIncludeTax: z.boolean(),
  }),
  fiscal: z.object({
    yearStartMonth: z.number().int().min(1).max(12),
  }),
  inventory: z.object({
    allowNegativeStock: z.boolean(),
    blockExpiredSale: z.boolean(),
    expiryWarningDays: z.number().int().min(0).max(3650),
  }),
  receipt: z.object({
    header: optionalText(500),
    footer: optionalText(500),
  }),
  pos: z.object({
    /** Largest line discount a cashier may give without a supervisor's approval. */
    maxDiscountPercent: z.number().min(0).max(100),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsKey = keyof Settings;
export const SETTINGS_KEYS = Object.keys(settingsSchema.shape) as SettingsKey[];

/** PATCH body: any subset of sections, each fully specified. */
export const settingsPatchSchema = settingsSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Provide at least one settings section',
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

const rateString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage with up to 4 decimal places')
  .refine((v) => Number(v) <= 100, 'Rate cannot exceed 100%');

export const taxRateInputSchema = z
  .object({
    code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'Use UPPER_SNAKE_CASE'),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']),
    rate: rateString,
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.kind === 'STANDARD' || /^0+(\.0+)?$/.test(v.rate), {
    message: 'Zero-rated and exempt taxes must have a 0% rate',
    path: ['rate'],
  });
export const taxRateUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    rate: rateString.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export interface TaxRateSummary {
  id: string;
  code: string;
  name: string;
  kind: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  rate: string;
  isActive: boolean;
}

export const locationInputSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,19}$/, 'Use uppercase letters, digits, - or _'),
  name: z.string().trim().min(1).max(80),
  type: z.enum(['STORE', 'WAREHOUSE']),
  isPosEnabled: z.boolean().default(false),
  isOnlineFulfilment: z.boolean().default(false),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).optional(),
  isActive: z.boolean().default(true),
});
export const locationUpdateSchema = locationInputSchema
  .omit({ code: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export interface LocationSummary {
  id: string;
  code: string;
  name: string;
  type: 'STORE' | 'WAREHOUSE';
  isPosEnabled: boolean;
  isOnlineFulfilment: boolean;
  address: string | null;
  phone: string | null;
  isActive: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  business: { name: 'Rhoyards', address: '', phone: '', email: '', taxId: '', vatRegistered: true },
  currency: { code: 'NGN', symbol: '₦' },
  pricing: { pricesIncludeTax: true },
  fiscal: { yearStartMonth: 1 },
  inventory: { allowNegativeStock: false, blockExpiredSale: true, expiryWarningDays: 90 },
  receipt: { header: '', footer: 'Thank you for shopping with us.' },
  pos: { maxDiscountPercent: 10 },
};
