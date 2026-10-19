import { dec, roundMoney, splitInclusiveTax, sum, ZERO, type Decimal, type DecimalInput } from './money';

/**
 * Sale-line pricing, shared by the POS screen (live totals) and the API (authoritative).
 * Both sides call the same function, so the till and the ledger can never disagree.
 *
 * Per line:
 *   gross    = round₂(qty × unitPrice)                    (in shelf-price terms)
 *   discount = percent → round₂(gross × pct / 100); amount → the amount (≤ gross)
 *   after    = gross − discount
 *   prices include VAT : tax = round₂(after × r / (100 + r)); net = after − tax; total = after
 *   prices exclude VAT : net = after; tax = round₂(net × r / 100); total = net + tax
 */

export interface PricingLineInput {
  qty: DecimalInput;
  unitPrice: DecimalInput;
  /** Percentage of the line (0–100) or a fixed amount off the line. */
  discount?: { type: 'percent' | 'amount'; value: DecimalInput } | null | undefined;
  /** VAT percentage for the line (0 for zero-rated/exempt or when not VAT-registered). */
  taxRate: DecimalInput;
}

export interface PricedLine {
  gross: Decimal;
  discount: Decimal;
  net: Decimal;
  tax: Decimal;
  total: Decimal;
  /** Discount as a percentage of the line's gross amount (for authorisation limits). */
  discountPercent: Decimal;
}

export interface PricedSale {
  lines: PricedLine[];
  grossTotal: Decimal;
  discountTotal: Decimal;
  subtotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  /** The largest discount on any line, as a percentage. */
  maxDiscountPercent: Decimal;
}

export class PricingError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

export function priceLine(input: PricingLineInput, pricesIncludeTax: boolean, lineNo = 1): PricedLine {
  const qty = dec(input.qty);
  const price = dec(input.unitPrice);
  if (qty.lte(ZERO)) throw new PricingError(`Line ${lineNo}: quantity must be positive`, lineNo);
  if (price.isNegative()) throw new PricingError(`Line ${lineNo}: price cannot be negative`, lineNo);
  const gross = roundMoney(qty.times(price));

  let discount = ZERO;
  if (input.discount) {
    const value = dec(input.discount.value);
    if (value.isNegative()) throw new PricingError(`Line ${lineNo}: discount cannot be negative`, lineNo);
    if (input.discount.type === 'percent') {
      if (value.gt(100)) throw new PricingError(`Line ${lineNo}: discount cannot exceed 100%`, lineNo);
      discount = roundMoney(gross.times(value).dividedBy(100));
    } else {
      if (roundMoney(value).gt(gross)) throw new PricingError(`Line ${lineNo}: discount is larger than the line`, lineNo);
      discount = roundMoney(value);
    }
  }

  const after = gross.minus(discount);
  const discountPercent = gross.isZero() ? ZERO : discount.times(100).dividedBy(gross);
  if (pricesIncludeTax) {
    const { net, tax } = splitInclusiveTax(after, input.taxRate);
    return { gross, discount, net, tax, total: after, discountPercent };
  }
  const tax = roundMoney(after.times(input.taxRate).dividedBy(100));
  return { gross, discount, net: after, tax, total: after.plus(tax), discountPercent };
}

export function priceSale(lines: PricingLineInput[], pricesIncludeTax: boolean): PricedSale {
  const priced = lines.map((l, i) => priceLine(l, pricesIncludeTax, i + 1));
  return {
    lines: priced,
    grossTotal: sum(priced.map((l) => l.gross)),
    discountTotal: sum(priced.map((l) => l.discount)),
    subtotal: sum(priced.map((l) => l.net)),
    taxTotal: sum(priced.map((l) => l.tax)),
    total: sum(priced.map((l) => l.total)),
    maxDiscountPercent: priced.reduce((m, l) => (l.discountPercent.gt(m) ? l.discountPercent : m), ZERO),
  };
}
