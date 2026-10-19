import { dec, PricingError, priceSale, type PricedSale, type SaleInput, type SuspendedCart, type VariantLookup } from '@rhoyards/shared';

export interface CartLine {
  variantId: string;
  sku: string;
  description: string;
  qty: string;
  unitPrice: string;
  /** Catalogue price; a different unitPrice is a price override. */
  listPrice: string;
  taxRate: string;
  allowsFraction: boolean;
  discount: { type: 'percent' | 'amount'; value: string } | null;
}

export interface Cart {
  lines: CartLine[];
  customer: { id: string; name: string; allowCredit?: boolean } | null;
  note: string;
}

export const emptyCart = (): Cart => ({ lines: [], customer: null, note: '' });

export function lineFromVariant(v: VariantLookup): CartLine {
  return {
    variantId: v.id,
    sku: v.sku,
    description: `${v.productName} — ${v.name}`,
    qty: '1',
    unitPrice: v.sellingPrice,
    listPrice: v.sellingPrice,
    taxRate: v.taxRate,
    allowsFraction: v.allowsFraction,
    discount: null,
  };
}

export function linesFromSuspended(cart: SuspendedCart): CartLine[] {
  return cart.lines.map((l) => ({ ...l, qty: l.qty.replace(/\.?0+$/, '') }));
}

/** Scanning the same item again adds one to its line instead of adding a new line. */
export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const i = lines.findIndex((l) => l.variantId === line.variantId && l.unitPrice === line.unitPrice && !l.discount);
  if (i === -1) return [...lines, line];
  return lines.map((l, j) => (j === i ? { ...l, qty: dec(l.qty).plus(1).toString() } : l));
}

export type CartTotals = { ok: true; priced: PricedSale } | { ok: false; error: string; line: number };

/** Live totals using the same pricing code as the API, so the till always matches the receipt. */
export function cartTotals(lines: CartLine[], pricesIncludeTax: boolean, vatRegistered: boolean): CartTotals {
  try {
    const valid = lines.map((l) => {
      if (!/^\d+(\.\d{1,3})?$/.test(l.qty) || dec(l.qty).lte(0)) throw new PricingError('Enter a quantity', 0);
      return { qty: l.qty, unitPrice: l.unitPrice || '0', discount: l.discount, taxRate: vatRegistered ? l.taxRate : '0' };
    });
    return { ok: true, priced: priceSale(valid, pricesIncludeTax) };
  } catch (e) {
    if (e instanceof PricingError) return { ok: false, error: e.message, line: e.line };
    return { ok: false, error: 'Check the quantities and prices', line: 0 };
  }
}

export function saleBody(registerId: string, cart: Cart): Omit<SaleInput, 'payments'> {
  return {
    registerId,
    customerId: cart.customer?.id ?? null,
    lines: cart.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount })),
    note: cart.note.trim() || null,
  };
}
