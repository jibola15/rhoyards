import DecimalBase from 'decimal.js';

/**
 * All money, quantity and rate arithmetic goes through this Decimal instance.
 * Never use JavaScript `number` arithmetic for business values.
 *
 * Rounding policy (see docs/ACCOUNTING_RULES.md): ROUND_HALF_UP.
 *  - money amounts: 2 dp, rounded at line level
 *  - unit costs / weighted-average cost: 4 dp
 *  - quantities: 3 dp
 */
export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });
export type Decimal = DecimalBase;
export type DecimalInput = DecimalBase.Value;

export const MONEY_DP = 2;
export const COST_DP = 4;
export const QTY_DP = 3;
export const RATE_DP = 4;

export const ZERO = new Decimal(0);

export function dec(value: DecimalInput): Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`Invalid numeric value: ${value}`);
  }
  return new Decimal(value);
}

export function roundMoney(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

export function roundCost(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(COST_DP, Decimal.ROUND_HALF_UP);
}

export function roundQty(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(QTY_DP, Decimal.ROUND_HALF_UP);
}

/** Serialise money for API responses: always a fixed 2-dp string, e.g. "12500.00". */
export function moneyString(value: DecimalInput): string {
  return roundMoney(value).toFixed(MONEY_DP);
}

export function sum(values: readonly DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(v), ZERO);
}

/**
 * Split a tax-inclusive gross amount into net + tax at the given percentage rate.
 * Tax is rounded to 2 dp and net = gross - tax, so net + tax always equals gross exactly.
 */
export function splitInclusiveTax(gross: DecimalInput, ratePercent: DecimalInput): { net: Decimal; tax: Decimal } {
  const g = roundMoney(gross);
  const rate = dec(ratePercent);
  if (rate.isZero()) return { net: g, tax: ZERO };
  const tax = roundMoney(g.times(rate).dividedBy(rate.plus(100)));
  return { net: g.minus(tax), tax };
}

/** Tax on a tax-exclusive net amount at the given percentage rate, rounded to 2 dp. */
export function exclusiveTax(net: DecimalInput, ratePercent: DecimalInput): Decimal {
  return roundMoney(dec(net).times(ratePercent).dividedBy(100));
}

/** Validates a decimal string for API input (no exponent notation, bounded scale). */
export function isDecimalString(value: string, maxDp: number): boolean {
  return new RegExp(`^-?\\d{1,15}(\\.\\d{1,${maxDp}})?$`).test(value);
}
