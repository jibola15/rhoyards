import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dec, moneyInput, sum, type CustomerReceiptDetail, type CustomerStatement, type DataEnvelope } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { api } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/format';
import { DocumentShell, InfoGrid } from '../purchasing/shared';
import { usePaymentMethods } from '../returns/api';

const isMoney = (v: string) => moneyInput.safeParse(v).success;
const today = () => new Date().toISOString().slice(0, 10);
const TYPE_LABEL = { SALE: 'Credit sale', RECEIPT: 'Payment', RETURN: 'Return credit' } as const;

function ReceiptDialog({ statement, onClose }: { statement: CustomerStatement; onClose: () => void }) {
  const queryClient = useQueryClient();
  const methods = usePaymentMethods();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [methodId, setMethodId] = useState('');
  const [reference, setReference] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const allocated = sum(Object.values(alloc).filter(isMoney));
  const left = isMoney(amount) ? dec(amount).minus(allocated) : dec(0);

  const oldestFirst = () => {
    if (!isMoney(amount)) return;
    let rest = dec(amount);
    const next: Record<string, string> = {};
    for (const s of statement.openSales) {
      const take = rest.gt(s.outstanding) ? dec(s.outstanding) : rest;
      if (take.gt(0)) next[s.id] = take.toFixed(2);
      rest = rest.minus(take);
    }
    setAlloc(next);
  };
  const save = useMutation({
    mutationFn: () =>
      api.post<DataEnvelope<CustomerReceiptDetail>>(
        '/customer-receipts',
        {
          customerId: statement.customer.id,
          receiptDate: date,
          paymentMethodId: methodId,
          amount,
          reference,
          allocations: Object.entries(alloc)
            .filter(([, v]) => isMoney(v) && Number(v) > 0)
            .map(([saleId, v]) => ({ saleId, amount: v })),
        },
        { headers: { 'Idempotency-Key': key } },
      ),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['customer-statement', statement.customer.id] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast.success(`Payment ${res.data.number} recorded`);
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a payment from {statement.customer.name}</DialogTitle>
          <DialogDescription>Apply it to their unpaid sales; anything left stays as credit on their account.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="rc-amount" label="Amount received (₦)">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field id="rc-date" label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field id="rc-method" label="Paid by">
            <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
              <option value="">Choose…</option>
              {methods.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="rc-ref" label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        {statement.openSales.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Apply to sales</span>
              <Button variant="outline" size="sm" disabled={!isMoney(amount)} onClick={oldestFirst}>
                Oldest first
              </Button>
            </div>
            {statement.openSales.map((s) => (
              <div key={s.id} className="grid grid-cols-[1fr_9rem] items-center gap-3 text-sm">
                <span>
                  <span className="font-mono">{s.number}</span> · {formatDate(s.date)} · {formatMoney(s.outstanding)} owed
                </span>
                <Input aria-label={`Apply to ${s.number}`} inputMode="decimal" value={alloc[s.id] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [s.id]: e.target.value }))} />
              </div>
            ))}
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Applied {formatMoney(allocated.toFixed(2))} · kept as credit {formatMoney(left.lt(0) ? '0' : left.toFixed(2))}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || !isMoney(amount) || !methodId || left.lt(0)} onClick={() => (setError(null), save.mutate())}>
            {save.isPending ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const [paying, setPaying] = useState(false);
  const statement = useQuery({
    queryKey: ['customer-statement', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<CustomerStatement>>(`/customers/${id}/statement`, { signal }).then((r) => r.data),
  });
  const s = statement.data;
  return (
    <DocumentShell back={{ to: '/customers', label: 'Customers' }} title={s ? s.customer.name : 'Customer'} isNew={false} query={statement}>
      {s && (
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-4 pt-5">
              <InfoGrid
                items={[
                  ['Code', <span key="c" className="font-mono">{s.customer.code}</span>],
                  ['Credit', s.customer.allowCredit ? (Number(s.customer.creditLimit) > 0 ? `Up to ${formatMoney(s.customer.creditLimit)}` : 'No limit') : 'Not allowed'],
                  ['Balance', <strong key="b">{dec(s.balance).lt(0) ? `${formatMoney(s.balance.slice(1))} in credit` : formatMoney(s.balance)}</strong>],
                  ['Unapplied payments', formatMoney(s.unappliedCredit)],
                ]}
              />
              <div className="flex gap-2">
                {can('customer_receipts.manage') && <Button onClick={() => setPaying(true)}>Record payment</Button>}
                <Link to={`/sales?customerId=${s.customer.id}`} className="inline-flex items-center text-sm underline">
                  All sales
                </Link>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>Account statement</CardTitle>
              <div className="flex gap-4 text-sm">
                <Link to={`/reports/customer-ledger?customerId=${s.customer.id}`} className="text-primary hover:underline">
                  Full ledger
                </Link>
                {can('reports.sales') && (
                  <Link to={`/reports/customer-items?customerId=${s.customer.id}`} className="text-primary hover:underline">
                    Items bought
                  </Link>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {s.lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">No credit sales or payments yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead className="text-right">Charged</TableHead>
                      <TableHead className="text-right">Paid / credited</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.lines.map((l) => (
                      <TableRow key={`${l.type}-${l.id}`}>
                        <TableCell>{formatDate(l.date)}</TableCell>
                        <TableCell>
                          {TYPE_LABEL[l.type]}{' '}
                          {l.type === 'SALE' ? (
                            <Link to={`/sales/${l.id}`} className="font-mono hover:underline">
                              {l.number}
                            </Link>
                          ) : l.type === 'RETURN' ? (
                            <Link to={`/returns/${l.id}`} className="font-mono hover:underline">
                              {l.number}
                            </Link>
                          ) : (
                            <span className="font-mono">{l.number}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(l.balance)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          {paying && <ReceiptDialog statement={s} onClose={() => setPaying(false)} />}
        </div>
      )}
    </DocumentShell>
  );
}
