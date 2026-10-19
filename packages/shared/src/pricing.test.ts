import { describe, expect, it } from 'vitest';
import { priceLine, priceSale, PricingError } from './pricing';

describe('sale pricing', () => {
  it('extracts VAT from inclusive shelf prices', () => {
    const s = priceSale([{ qty: '2', unitPrice: '5375', taxRate: '7.5' }], true);
    expect(s.total.toFixed(2)).toBe('10750.00');
    expect(s.taxTotal.toFixed(2)).toBe('750.00');
    expect(s.subtotal.toFixed(2)).toBe('10000.00');
  });

  it('adds VAT on top of exclusive prices', () => {
    const s = priceSale([{ qty: '2', unitPrice: '5000', taxRate: '7.5' }], false);
    expect(s.subtotal.toFixed(2)).toBe('10000.00');
    expect(s.taxTotal.toFixed(2)).toBe('750.00');
    expect(s.total.toFixed(2)).toBe('10750.00');
  });

  it('applies percentage and amount discounts before tax', () => {
    const pct = priceLine({ qty: '1', unitPrice: '10000', taxRate: '7.5', discount: { type: 'percent', value: '10' } }, true);
    expect(pct.discount.toFixed(2)).toBe('1000.00');
    expect(pct.total.toFixed(2)).toBe('9000.00');
    expect(pct.net.plus(pct.tax).toFixed(2)).toBe('9000.00');
    expect(pct.discountPercent.toFixed(2)).toBe('10.00');

    const amt = priceLine({ qty: '3', unitPrice: '1000', taxRate: '0', discount: { type: 'amount', value: '450' } }, false);
    expect(amt.total.toFixed(2)).toBe('2550.00');
    expect(amt.discountPercent.toFixed(2)).toBe('15.00');
  });

  it('keeps net + tax = total on every line, whatever the rounding', () => {
    const s = priceSale(
      [
        { qty: '3', unitPrice: '333.33', taxRate: '7.5' },
        { qty: '1', unitPrice: '999.99', taxRate: '7.5', discount: { type: 'percent', value: '12.5' } },
        { qty: '7', unitPrice: '0.99', taxRate: '0' },
      ],
      true,
    );
    for (const l of s.lines) expect(l.net.plus(l.tax).toFixed(2)).toBe(l.total.toFixed(2));
    expect(s.subtotal.plus(s.taxTotal).toFixed(2)).toBe(s.total.toFixed(2));
    expect(s.grossTotal.minus(s.discountTotal).toFixed(2)).toBe(s.total.toFixed(2));
  });

  it('rejects impossible discounts and quantities', () => {
    expect(() => priceLine({ qty: '1', unitPrice: '100', taxRate: '0', discount: { type: 'amount', value: '101' } }, true)).toThrow(PricingError);
    expect(() => priceLine({ qty: '1', unitPrice: '100', taxRate: '0', discount: { type: 'percent', value: '120' } }, true)).toThrow(PricingError);
    expect(() => priceLine({ qty: '0', unitPrice: '100', taxRate: '0' }, true)).toThrow(/quantity/);
  });
});
