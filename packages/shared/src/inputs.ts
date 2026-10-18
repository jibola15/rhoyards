import { z } from 'zod';

/** Decimal-string field schemas. Business numbers travel as strings so no float conversion happens. */
const decimal = (intDigits: number, dp: number, signed = false) =>
  new RegExp(`^${signed ? '-?' : ''}\\d{1,${intDigits}}(\\.\\d{1,${dp}})?$`);

export const moneyInput = z.string().trim().regex(decimal(13, 2), 'Enter an amount with up to 2 decimal places');
export const costInput = z.string().trim().regex(decimal(13, 4), 'Enter a cost with up to 4 decimal places');
export const qtyInput = z.string().trim().regex(decimal(11, 3), 'Enter a quantity with up to 3 decimal places');
export const signedQtyInput = z
  .string()
  .trim()
  .regex(decimal(11, 3, true), 'Enter a quantity with up to 3 decimal places')
  .refine((v) => !/^-?0+(\.0+)?$/.test(v), 'Quantity cannot be zero');
export const positiveQtyInput = qtyInput.refine((v) => !/^0+(\.0+)?$/.test(v), 'Quantity must be greater than zero');

/** Calendar date, YYYY-MM-DD. */
export const dateInput = z.iso.date('Enter a date as YYYY-MM-DD');

/**
 * Optional free text. A missing key means "not provided" (left unchanged on update);
 * a blank string or null means "clear it" and becomes null.
 */
export const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .transform((v) => (v ? v : null))
    .optional();

/** Optional reference. Missing = not provided; '' or null = none (cleared). */
export const optionalId = z
  .union([z.uuid(), z.literal(''), z.null()])
  .transform((v) => (v ? v : null))
  .optional();

export const booleanQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
