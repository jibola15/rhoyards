import { dec, isDecimalString, moneyString, ZERO, type PaymentMethodSummary } from '@rhoyards/shared';

export interface PaymentRow {
  methodId: string;
  /** Cash rows: cash received. Other rows: amount charged. */
  value: string;
  reference: string;
}

export const moneyOrZero = (v: string) => (isDecimalString(v.trim(), 2) ? dec(v.trim()) : ZERO);

/**
 * Works out what each payment applies to the sale. Card/transfer amounts apply first; cash covers the
 * rest and any extra cash is change.
 */
export function allocatePayments(total: string, rows: PaymentRow[], methods: PaymentMethodSummary[]) {
  const kind = (id: string) => methods.find((m) => m.id === id)?.kind;
  const nonCash = rows.filter((r) => kind(r.methodId) !== 'CASH').reduce((s, r) => s.plus(moneyOrZero(r.value)), ZERO);
  let cashRoom = dec(total).minus(nonCash);
  if (cashRoom.isNegative()) cashRoom = ZERO;
  let change = ZERO;
  const applied = rows.map((r) => {
    if (kind(r.methodId) !== 'CASH') return { ...r, amount: moneyOrZero(r.value), tendered: null as string | null };
    const received = moneyOrZero(r.value);
    const amount = received.gt(cashRoom) ? cashRoom : received;
    cashRoom = cashRoom.minus(amount);
    change = change.plus(received.minus(amount));
    return { ...r, amount, tendered: moneyString(received) };
  });
  const paid = applied.reduce((s, r) => s.plus(r.amount), ZERO);
  return { applied, paid, change, remaining: dec(total).minus(paid), overpaid: nonCash.gt(total) };
}
