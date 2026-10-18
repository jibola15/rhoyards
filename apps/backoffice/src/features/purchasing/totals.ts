import { dec, exclusiveTax, roundMoney, sum } from '@rhoyards/shared';

const isNumberish = (v: string) => /^\d+(\.\d+)?$/.test(v.trim());

/** Live totals for priced lines (VAT exclusive), using the same decimal maths as the server. */
export function lineTotals(lines: { qty: string; unitCost: string; taxRate: string }[]) {
  const parts = lines.map((l) => {
    if (!isNumberish(l.qty) || !isNumberish(l.unitCost)) return { net: dec(0), tax: dec(0) };
    const net = roundMoney(dec(l.qty).times(l.unitCost));
    return { net, tax: exclusiveTax(net, l.taxRate || '0') };
  });
  const subtotal = sum(parts.map((p) => p.net));
  const tax = sum(parts.map((p) => p.tax));
  return { parts, subtotal, tax, total: subtotal.plus(tax) };
}
