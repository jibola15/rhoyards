import { describe, expect, it } from 'vitest';
import {
  dec,
  exclusiveTax,
  isDecimalString,
  moneyString,
  roundCost,
  roundMoney,
  splitInclusiveTax,
  sum,
} from './money';

describe('money helpers', () => {
  it('avoids binary floating-point error', () => {
    expect(dec('0.1').plus('0.2').toString()).toBe('0.3');
    expect(sum(['0.1', '0.2', '0.3']).toString()).toBe('0.6');
  });

  it('rounds half-up at 2 dp for money and 4 dp for cost', () => {
    expect(roundMoney('2.345').toFixed(2)).toBe('2.35');
    expect(roundMoney('2.344').toFixed(2)).toBe('2.34');
    expect(roundMoney('-2.345').toFixed(2)).toBe('-2.35');
    expect(roundCost('1.23455').toFixed(4)).toBe('1.2346');
  });

  it('serialises money as fixed 2-dp strings', () => {
    expect(moneyString('12500')).toBe('12500.00');
    expect(moneyString('0.005')).toBe('0.01');
  });

  it('splits tax-inclusive amounts so net + tax equals gross exactly', () => {
    const { net, tax } = splitInclusiveTax('10750.00', '7.5');
    expect(tax.toFixed(2)).toBe('750.00');
    expect(net.toFixed(2)).toBe('10000.00');

    const odd = splitInclusiveTax('999.99', '7.5');
    expect(odd.net.plus(odd.tax).toFixed(2)).toBe('999.99');
  });

  it('returns zero tax for zero-rated items', () => {
    const { net, tax } = splitInclusiveTax('500', '0');
    expect(tax.isZero()).toBe(true);
    expect(net.toFixed(2)).toBe('500.00');
  });

  it('calculates exclusive tax', () => {
    expect(exclusiveTax('10000', '7.5').toFixed(2)).toBe('750.00');
    expect(exclusiveTax('333.33', '7.5').toFixed(2)).toBe('25.00');
  });

  it('rejects non-finite numbers', () => {
    expect(() => dec(Number.NaN)).toThrow(RangeError);
  });

  it('validates decimal strings', () => {
    expect(isDecimalString('12.50', 2)).toBe(true);
    expect(isDecimalString('12.505', 2)).toBe(false);
    expect(isDecimalString('1e5', 2)).toBe(false);
    expect(isDecimalString('abc', 2)).toBe(false);
  });
});
