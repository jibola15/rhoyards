import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { z } from 'zod';
import { dec, moneyInput, sum, type DataEnvelope, type ListEnvelope, type SupplierInvoiceSummary, type SupplierPaymentDetail } from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Skeleton, Textarea, toast } from '@rhoyards/ui';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { today, useAccountOptions, useDocument, useRefreshPurchasing, useSupplierOptions } from './api';
import { DocumentShell, InfoGrid } from './shared';

const KEY = 'supplier-payments';
const isMoney = (v: string) => moneyInput.safeParse(v).success;

const formSchema = z
  .object({
    paymentDate: z.string().min(1, 'Enter the payment date'),
    accountId: z.string().min(1, 'Choose the account paid from'),
    amount: moneyInput.refine((v) => Number(v) > 0, 'Enter an amount greater than zero'),
    reference: z.string().max(80),
    note: z.string().max(500),
    allocations: z.array(z.object({ invoiceId: z.string(), number: z.string(), supplierRef: z.string(), dueDate: z.string(), outstanding: z.string(), amount: z.string() })),
  })
  .superRefine((v, ctx) => {
    v.allocations.forEach((a, i) => {
      if (a.amount === '') return;
      if (!isMoney(a.amount)) ctx.addIssue({ code: 'custom', path: ['allocations', i, 'amount'], message: 'Enter an amount' });
      else if (dec(a.amount).gt(a.outstanding)) ctx.addIssue({ code: 'custom', path: ['allocations', i, 'amount'], message: `At most ${formatMoney(a.outstanding)}` });
    });
    const allocated = sum(v.allocations.filter((a) => isMoney(a.amount)).map((a) => a.amount));
    if (isMoney(v.amount) && allocated.gt(v.amount)) ctx.addIssue({ code: 'custom', path: ['amount'], message: `Allocations total ${formatMoney(allocated.toFixed(2))}, more than the payment` });
  });
type FormValues = z.infer<typeof formSchema>;

function PaymentForm({ supplierId, invoices, preselect }: { supplierId: string; invoices: SupplierInvoiceSummary[]; preselect?: string | undefined }) {
  const navigate = useNavigate();
  const accounts = useAccountOptions('payment');
  const refresh = useRefreshPurchasing();
  // One key per form: a double submit or a retry after a network error cannot record the payment twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [formError, setFormError] = useState<string | null>(null);
  const pre = invoices.find((i) => i.id === preselect);
  const { register, control, handleSubmit, setValue, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      paymentDate: today(),
      accountId: '',
      amount: pre?.outstanding ?? '',
      reference: '',
      note: '',
      allocations: invoices.map((i) => ({
        invoiceId: i.id,
        number: i.number,
        supplierRef: i.supplierRef,
        dueDate: i.dueDate,
        outstanding: i.outstanding,
        amount: i.id === preselect ? i.outstanding : '',
      })),
    },
  });
  const amount = useWatch({ control, name: 'amount' });
  const allocations = useWatch({ control, name: 'allocations' });
  const allocated = sum(allocations.filter((a) => isMoney(a.amount)).map((a) => a.amount));
  const unallocated = isMoney(amount) ? dec(amount).minus(allocated) : dec(0);

  const autoAllocate = () => {
    if (!isMoney(amount)) return;
    let left = dec(amount);
    allocations.forEach((a, i) => {
      const take = left.gt(a.outstanding) ? dec(a.outstanding) : left;
      setValue(`allocations.${i}.amount`, take.gt(0) ? take.toFixed(2) : '', { shouldDirty: true });
      left = left.minus(take);
    });
  };

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      api.post<DataEnvelope<SupplierPaymentDetail>>(
        '/supplier-payments',
        {
          supplierId,
          paymentDate: v.paymentDate,
          accountId: v.accountId,
          amount: v.amount,
          reference: v.reference,
          note: v.note,
          allocations: v.allocations.filter((a) => isMoney(a.amount) && Number(a.amount) > 0).map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
        },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      ),
    onSuccess: async (res) => {
      await refresh(KEY, res.data.id, res.data);
      toast.success(`Payment ${res.data.number} of ${formatMoney(res.data.amount)} recorded`);
      navigate(`/purchasing/payments/${res.data.id}`, { replace: true });
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['paymentDate', 'accountId', 'amount', 'reference', 'note'])),
  });
  const e = formState.errors;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="pay-date" label="Payment date" error={e.paymentDate?.message}>
            <Input type="date" {...register('paymentDate')} />
          </Field>
          <Field id="pay-account" label="Paid from" error={e.accountId?.message}>
            <Select {...register('accountId')}>
              <option value="">Choose…</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="pay-amount" label="Amount (₦)" error={e.amount?.message}>
            <Input inputMode="decimal" {...register('amount')} />
          </Field>
          <Field id="pay-ref" label="Transfer / cheque reference">
            <Input {...register('reference')} />
          </Field>
          <Field id="pay-note" label="Note" className="sm:col-span-2 lg:col-span-4">
            <Textarea rows={1} {...register('note')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>Apply to invoices</CardTitle>
          <Button variant="outline" size="sm" disabled={!isMoney(amount) || invoices.length === 0} onClick={autoAllocate}>
            Oldest first
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {invoices.length === 0 && <p className="text-sm text-muted-foreground">No unpaid invoices. The payment will be held as a credit with the supplier.</p>}
          {allocations.map((a, i) => (
            <div key={a.invoiceId} className="grid items-end gap-3 rounded-md border p-3 sm:grid-cols-[1fr_10rem]">
              <div className="text-sm">
                <span className="font-mono font-medium">{a.number}</span> · their no. <span className="font-mono">{a.supplierRef}</span>
                <div className="text-xs text-muted-foreground">
                  Due {formatDate(a.dueDate)} · {formatMoney(a.outstanding)} outstanding
                </div>
              </div>
              <Field id={`al-${i}`} label="Apply (₦)" error={e.allocations?.[i]?.amount?.message}>
                <Input inputMode="decimal" {...register(`allocations.${i}.amount`)} />
              </Field>
            </div>
          ))}
          <dl className="ml-auto grid max-w-xs grid-cols-2 gap-1 pt-2 text-sm">
            <dt className="text-muted-foreground">Applied</dt>
            <dd className="text-right tabular-nums">{formatMoney(allocated.toFixed(2))}</dd>
            <dt className="text-muted-foreground">Held as credit</dt>
            <dd className="text-right tabular-nums">{formatMoney(unallocated.lt(0) ? '0' : unallocated.toFixed(2))}</dd>
          </dl>
        </CardContent>
      </Card>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Recording…' : 'Record payment'}
      </Button>
    </form>
  );
}

function NewPayment() {
  const [params] = useSearchParams();
  const suppliers = useSupplierOptions();
  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const invoices = useQuery({
    queryKey: ['supplier-invoices', 'open', supplierId],
    queryFn: ({ signal }) => api.get<ListEnvelope<SupplierInvoiceSummary>>(`/supplier-invoices?supplierId=${supplierId}&openOnly=true&pageSize=100`, { signal }).then((r) => r.data),
    enabled: Boolean(supplierId),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-5">
          <Field id="pay-supplier" label="Supplier" className="max-w-md">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Choose…</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>
      {supplierId && invoices.isPending && <Skeleton className="h-40 w-full" />}
      {invoices.isError && <Alert variant="destructive">{invoices.error.message}</Alert>}
      {invoices.data && <PaymentForm key={supplierId} supplierId={supplierId} invoices={invoices.data} preselect={params.get('invoiceId') ?? undefined} />}
    </div>
  );
}

function PaymentView({ payment }: { payment: SupplierPaymentDetail }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-5">
          <InfoGrid
            items={[
              ['Supplier', <Link key="s" to={`/suppliers/${payment.supplier.id}`} className="hover:underline">{payment.supplier.name}</Link>],
              ['Date', formatDate(payment.paymentDate)],
              ['Paid from', payment.account.name],
              ['Reference', payment.reference ?? '—'],
              ['Amount', <strong key="a">{formatMoney(payment.amount)}</strong>],
              ['Held as credit', formatMoney(payment.unallocated)],
              ['Recorded', `${formatDateTime(payment.createdAt)} · ${payment.createdBy}`],
              ...(payment.note ? ([['Note', payment.note]] as [string, string][]) : []),
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Applied to</CardTitle>
        </CardHeader>
        <CardContent>
          {payment.allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not applied to any invoice.</p>
          ) : (
            <ul className="divide-y text-sm">
              {payment.allocations.map((a) => (
                <li key={a.invoiceId} className="flex justify-between py-2">
                  <Link to={`/purchasing/invoices/${a.invoiceId}`} className="font-mono hover:underline">
                    {a.number} ({a.supplierRef})
                  </Link>
                  <span className="tabular-nums">{formatMoney(a.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-muted-foreground">Payments are final. To correct a mistake, ask your accountant to reverse the journal entry.</p>
        </CardContent>
      </Card>
    </div>
  );
}

export function SupplierPaymentPage() {
  const { id } = useParams();
  const doc = useDocument<SupplierPaymentDetail>(KEY, '/supplier-payments', id);
  return (
    <DocumentShell back={{ to: '/purchasing/payments', label: 'Supplier payments' }} title={id ? (doc.data ? `Payment ${doc.data.number}` : 'Payment') : 'Record supplier payment'} isNew={!id} query={doc}>
      {!id && <NewPayment />}
      {doc.data && <PaymentView payment={doc.data} />}
    </DocumentShell>
  );
}
