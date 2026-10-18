const dateTime = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });
// Display only: amounts arrive as exact decimal strings and are never used for arithmetic here.
const money = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

/** Formats a YYYY-MM-DD calendar date without shifting it across time zones. */
export function formatDate(isoDate: string | null | undefined): string {
  return isoDate ? dateOnly.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`)) : '—';
}

export function formatMoney(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : money.format(Number(value));
}

/** "12.500" → "12.5", "10.000" → "10". */
export function formatQty(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export function formatPriceRange(min: string | null, max: string | null): string {
  if (!min || !max) return '—';
  return min === max ? formatMoney(min) : `${formatMoney(min)} – ${formatMoney(max)}`;
}
