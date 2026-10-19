import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { ApiError, moneyString, type DataEnvelope, type PaymentMethodSummary, type SaleDetail, type SaleInput } from '@rhoyards/shared';
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input } from '@rhoyards/ui';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { allocatePayments, moneyOrZero, type PaymentRow } from './payments';

export function PaymentDialog({
  open,
  onOpenChange,
  total,
  body,
  methods,
  customer,
  canCredit,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  total: string;
  body: Omit<SaleInput, 'payments'>;
  methods: PaymentMethodSummary[];
  customer: { id: string; name: string; allowCredit?: boolean } | null;
  canCredit: boolean;
  onComplete: (sale: SaleDetail) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>Amount due: {formatMoney(total)}</DialogDescription>
        </DialogHeader>
        {open && <PaymentForm total={total} body={body} methods={methods} customer={customer} canCredit={canCredit} onComplete={onComplete} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function PaymentForm({
  total,
  body,
  methods,
  customer,
  canCredit,
  onComplete,
  onCancel,
}: {
  total: string;
  body: Omit<SaleInput, 'payments'>;
  methods: PaymentMethodSummary[];
  customer: { id: string; name: string; allowCredit?: boolean } | null;
  canCredit: boolean;
  onComplete: (sale: SaleDetail) => void;
  onCancel: () => void;
}) {
  const cash = methods.find((m) => m.kind === 'CASH');
  const [rows, setRows] = useState<PaymentRow[]>(cash ? [{ methodId: cash.id, value: total, reference: '' }] : []);
  const [approval, setApproval] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key per distinct request: a retry of the same request (e.g. after a network error) reuses it,
  // so the sale cannot be recorded twice.
  const keyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const { applied, paid, change, remaining, overpaid } = allocatePayments(total, rows, methods);
  const creditAllowed = Boolean(customer?.allowCredit) && canCredit;
  const missingRef = applied.find((r) => r.amount.gt(0) && methods.find((m) => m.id === r.methodId)?.requiresReference && !r.reference.trim());
  const canSubmit = !overpaid && !missingRef && (remaining.lte(0) || creditAllowed) && (!approval || (approval.email && approval.password));

  const mutation = useMutation({
    mutationFn: () => {
      const payments = applied
        .filter((r) => r.amount.gt(0))
        .map((r) => ({ paymentMethodId: r.methodId, amount: moneyString(r.amount), ...(r.tendered ? { tendered: r.tendered } : {}), reference: r.reference.trim() || null }));
      const request: SaleInput = { ...body, payments, ...(approval ? { discountApproval: approval } : {}) };
      const fingerprint = JSON.stringify({ ...request, discountApproval: approval?.email });
      if (keyRef.current?.fingerprint !== fingerprint) keyRef.current = { fingerprint, key: crypto.randomUUID() };
      return api.post<DataEnvelope<SaleDetail>>('/pos/sales', request, { headers: { 'Idempotency-Key': keyRef.current.key } });
    },
    onSuccess: (res) => onComplete(res.data),
    onError: (e) => {
      if (e instanceof ApiError && e.status === 403 && (e.details as { approvalRequired?: boolean } | undefined)?.approvalRequired) {
        setApproval((a) => a ?? { email: '', password: '' });
      }
      setError(e.message);
    },
  });

  const addMethod = (m: PaymentMethodSummary) => {
    const existing = rows.findIndex((r) => r.methodId === m.id);
    const rest = remaining.gt(0) ? moneyString(remaining) : '0.00';
    if (existing >= 0) setRows(rows.map((r, i) => (i === existing ? { ...r, value: moneyString(moneyOrZero(r.value).plus(rest)) } : r)));
    else setRows([...rows, { methodId: m.id, value: rest, reference: '' }]);
  };
  const update = (i: number, patch: Partial<PaymentRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (canSubmit) mutation.mutate();
      }}
    >
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Add a payment method">
        {methods.map((m) => (
          <Button key={m.id} type="button" variant="outline" size="sm" onClick={() => addMethod(m)}>
            {m.name}
          </Button>
        ))}
      </div>
      <ul className="grid gap-3">
        {rows.map((r, i) => {
          const m = methods.find((x) => x.id === r.methodId)!;
          const isCash = m.kind === 'CASH';
          return (
            <li key={r.methodId} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field id={`pay-${i}`} label={isCash ? `${m.name} received` : `${m.name} amount`}>
                <Input inputMode="decimal" value={r.value} onChange={(e) => update(i, { value: e.target.value })} onFocus={(e) => e.target.select()} autoFocus={i === rows.length - 1} />
              </Field>
              {m.requiresReference || !isCash ? (
                <Field id={`ref-${i}`} label={m.requiresReference ? 'Reference (required)' : 'Reference'}>
                  <Input value={r.reference} onChange={(e) => update(i, { reference: e.target.value })} />
                </Field>
              ) : (
                <div className="text-sm text-muted-foreground sm:pb-2">Applied: {formatMoney(moneyString(applied[i]!.amount))}</div>
              )}
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${m.name}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </li>
          );
        })}
      </ul>

      <dl className="grid grid-cols-2 gap-y-1 rounded-md bg-muted/50 p-3 text-sm">
        <dt>Paid</dt>
        <dd className="text-right font-medium tabular-nums">{formatMoney(moneyString(paid))}</dd>
        {change.gt(0) && (
          <>
            <dt className="text-base font-semibold">Change due</dt>
            <dd className="text-right text-base font-semibold tabular-nums" aria-live="polite">
              {formatMoney(moneyString(change))}
            </dd>
          </>
        )}
        {remaining.gt(0) && (
          <>
            <dt>{creditAllowed ? `On ${customer!.name}'s account` : 'Still to pay'}</dt>
            <dd className="text-right font-medium tabular-nums text-destructive">{formatMoney(moneyString(remaining))}</dd>
          </>
        )}
      </dl>
      {overpaid && <Alert variant="destructive">Card and transfer payments are more than the amount due.</Alert>}
      {missingRef && <p className="text-sm text-destructive">Enter the reference for {methods.find((m) => m.id === missingRef.methodId)?.name}.</p>}
      {remaining.gt(0) && !creditAllowed && (
        <p className="text-sm text-muted-foreground">
          {customer?.allowCredit ? 'You are not allowed to sell on credit.' : 'Add payments to cover the total, or choose a customer with a credit account.'}
        </p>
      )}

      {approval && (
        <fieldset className="grid gap-3 rounded-md border border-amber-500/50 p-3">
          <legend className="px-1 text-sm font-medium">Supervisor approval for the discount</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="appr-email" label="Supervisor email">
              <Input type="email" autoComplete="off" value={approval.email} onChange={(e) => setApproval({ ...approval, email: e.target.value })} />
            </Field>
            <Field id="appr-password" label="Supervisor password">
              <Input type="password" autoComplete="off" value={approval.password} onChange={(e) => setApproval({ ...approval, password: e.target.value })} />
            </Field>
          </div>
        </fieldset>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Back to sale
        </Button>
        <Button type="submit" disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? 'Completing…' : 'Complete sale'}
        </Button>
      </DialogFooter>
    </form>
  );
}
