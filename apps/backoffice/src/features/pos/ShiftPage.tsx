import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { dec, isDecimalString, moneyString, type ShiftSummary } from '@rhoyards/shared';
import { Alert, Badge, Button, buttonVariants, Card, CardContent, CardHeader, CardTitle, Field, Input, Skeleton, Textarea, toast } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { DocumentList } from '../../components/DocumentList';
import { PageHeader, QueryError } from '../../components/page';
import { api } from '../../lib/api';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useRefreshPos, useShift } from './api';

const SHIFT_STATUSES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'CLOSED', label: 'Closed' },
];

export function ShiftsPage() {
  return (
    <DocumentList<ShiftSummary>
      title="Cashier shifts"
      description="Each shift's takings and the cash count when it was closed."
      queryKey="shifts"
      path="/pos/shifts"
      statuses={SHIFT_STATUSES}
      searchPlaceholder="Search by shift number or cashier"
      columns={[
        { header: 'Shift', cell: (s) => <Link to={`/pos/shifts/${s.id}`} className="font-medium hover:underline">{s.number}</Link> },
        { header: 'Till', cell: (s) => s.register.name },
        { header: 'Cashier', cell: (s) => s.cashier.name },
        { header: 'Opened', cell: (s) => formatDateTime(s.openedAt), className: 'hidden md:table-cell' },
        { header: 'Status', cell: (s) => <Badge variant={s.status === 'OPEN' ? 'default' : 'secondary'}>{s.status === 'OPEN' ? 'Open' : 'Closed'}</Badge> },
        { header: 'Takings', cell: (s) => formatMoney(s.salesTotal), className: 'text-right' },
        { header: 'Over / short', cell: (s) => (s.variance === null ? '—' : formatMoney(s.variance)), className: 'text-right' },
      ]}
    />
  );
}

export function ShiftPage() {
  const { id } = useParams();
  const { can, session } = useAuth();
  const user = session?.user;
  const shift = useShift(id);
  if (shift.isError) return <QueryError error={shift.error} onRetry={() => void shift.refetch()} />;
  if (shift.isPending) return <Skeleton className="h-96 w-full" />;
  const s = shift.data;
  const mayClose = s.status === 'OPEN' && ((s.cashier.id === user?.id && can('pos.shift.manage')) || can('pos.shift.reconcile'));

  const row = (label: string, value: string) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </>
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Shift ${s.number}`}
        description={`${s.register.name} · ${s.cashier.name} · opened ${formatDateTime(s.openedAt)}${s.closedAt ? ` · closed ${formatDateTime(s.closedAt)} by ${s.closedBy}` : ''}`}
        actions={
          <>
            {s.status === 'OPEN' && s.cashier.id === user?.id && (
              <Link to="/pos" className={buttonVariants({ variant: 'outline' })}>
                Back to till
              </Link>
            )}
            <Link to={`/sales?shiftId=${s.id}`} className={buttonVariants({ variant: 'outline' })}>
              Sales in this shift
            </Link>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Takings</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
              {row('Sales', String(s.salesCount))}
              {row('Total sold', formatMoney(s.salesTotal))}
              {row('Discounts given', formatMoney(s.discountTotal))}
              {row('VAT collected', formatMoney(s.taxTotal))}
              {row('Sold on credit', formatMoney(s.creditTotal))}
              {s.byMethod.map((m) => row(m.name, formatMoney(m.amount)))}
              {row('Opening float', formatMoney(s.openingFloat))}
              <dt className="font-semibold">Expected cash</dt>
              <dd className="text-right font-semibold tabular-nums">{formatMoney(s.expectedCash)}</dd>
              {s.countedCash !== null && row('Counted cash', formatMoney(s.countedCash))}
              {s.variance !== null && (
                <>
                  <dt className="font-semibold">{dec(s.variance).isNegative() ? 'Short' : dec(s.variance).isZero() ? 'Balanced' : 'Over'}</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatMoney(s.variance)}</dd>
                </>
              )}
            </dl>
            {s.closeNote && <p className="mt-3 text-sm text-muted-foreground">Note: {s.closeNote}</p>}
          </CardContent>
        </Card>
        {mayClose && <CloseShiftCard shift={s} />}
      </div>
    </div>
  );
}

function CloseShiftCard({ shift }: { shift: ShiftSummary }) {
  const refresh = useRefreshPos();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = isDecimalString(counted.trim(), 2);
  const variance = valid ? dec(counted.trim()).minus(shift.expectedCash) : null;
  const close = useMutation({
    mutationFn: () => api.post(`/pos/shifts/${shift.id}/close`, { countedCash: counted.trim(), note: note.trim() || null }),
    onSuccess: async () => {
      toast.success(`Shift ${shift.number} closed`);
      await refresh();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Close shift</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (valid) close.mutate();
          }}
        >
          {error && <Alert variant="destructive">{error}</Alert>}
          <Field id="counted" label="Cash counted in the drawer" description="Count all notes and coins, including the opening float.">
            <Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
          </Field>
          {variance && (
            <p className="text-sm" aria-live="polite">
              {variance.isZero() ? 'The drawer balances.' : `${variance.isNegative() ? 'Short' : 'Over'} by ${formatMoney(moneyString(variance.abs()))} — this is posted to cash over/short.`}
            </p>
          )}
          <Field id="close-note" label="Note">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" disabled={!valid || close.isPending}>
              {close.isPending ? 'Closing…' : 'Close shift'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
