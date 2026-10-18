import { useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Banknote, Pencil, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { costInput, positiveQtyInput, type DataEnvelope, type OpenReceiptLine, type SupplierInvoiceDetail } from '@rhoyards/shared';
import {
  Alert,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { ConfirmAction } from '../../components/ConfirmAction';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { useTaxRates } from '../catalog/api';
import { today, useAccountOptions, useDocument, useRefreshPurchasing, useSupplierOptions } from './api';
import { DocumentShell, InfoGrid, TotalsBox } from './shared';
import { lineTotals } from './totals';

const KEY = 'supplier-invoices';

const formSchema = z.object({
  supplierRef: z.string().trim().min(1, "Enter the supplier's invoice number").max(60),
  invoiceDate: z.string().min(1, 'Enter the invoice date'),
  dueDate: z.string(),
  note: z.string().max(1000),
  goods: z.array(
    z.object({
      include: z.boolean(),
      grnLineId: z.string(),
      label: z.string(),
      receiptNumber: z.string(),
      open: z.string(),
      receiptCost: z.string(),
      taxRate: z.string(),
      qty: z.string(),
      unitCost: z.string(),
    }),
  ),
  charges: z.array(
    z.object({
      accountId: z.string().min(1, 'Choose an account'),
      description: z.string().trim().min(1, 'Describe the charge').max(200),
      qty: positiveQtyInput,
      unitCost: costInput,
      taxRateId: z.string(),
    }),
  ),
}).superRefine((v, ctx) => {
  v.goods.forEach((g, i) => {
    if (!g.include) return;
    if (!positiveQtyInput.safeParse(g.qty).success) ctx.addIssue({ code: 'custom', path: ['goods', i, 'qty'], message: 'Enter a quantity' });
    else if (Number(g.qty) > Number(g.open)) ctx.addIssue({ code: 'custom', path: ['goods', i, 'qty'], message: `At most ${formatQty(g.open)}` });
    if (!costInput.safeParse(g.unitCost).success) ctx.addIssue({ code: 'custom', path: ['goods', i, 'unitCost'], message: 'Enter the invoiced price' });
  });
  if (!v.goods.some((g) => g.include) && v.charges.length === 0) ctx.addIssue({ code: 'custom', path: ['goods'], message: 'Select received goods or add a charge' });
});
type FormValues = z.infer<typeof formSchema>;

function InvoiceForm({ supplierId, existing, openLines, onDone }: { supplierId: string; existing?: SupplierInvoiceDetail | undefined; openLines: OpenReceiptLine[]; onDone: (i: SupplierInvoiceDetail) => void }) {
  const taxRates = useTaxRates();
  const expenseAccounts = useAccountOptions('expense');
  const [formError, setFormError] = useState<string | null>(null);
  const onInvoice = new Map((existing?.lines ?? []).filter((l) => l.grnLineId).map((l) => [l.grnLineId!, l]));
  const { register, control, handleSubmit, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      supplierRef: existing?.supplierRef ?? '',
      invoiceDate: existing?.invoiceDate ?? today(),
      dueDate: existing?.dueDate ?? '',
      note: existing?.note ?? '',
      goods: openLines.map((l) => {
        const current = onInvoice.get(l.grnLineId);
        return {
          include: Boolean(current) || !existing,
          grnLineId: l.grnLineId,
          label: `${l.variant.productName} — ${l.variant.name}`,
          receiptNumber: l.receiptNumber,
          open: l.qtyInvoiceable,
          receiptCost: l.unitCost,
          taxRate: l.taxRate,
          qty: formatQty(current?.qty ?? l.qtyInvoiceable),
          unitCost: formatQty(current?.unitCost ?? l.unitCost),
        };
      }),
      charges: (existing?.lines ?? [])
        .filter((l) => l.account)
        .map((l) => ({ accountId: l.account!.id, description: l.description, qty: formatQty(l.qty), unitCost: formatQty(l.unitCost), taxRateId: l.taxRateId ?? '' })),
    },
  });
  const goods = useWatch({ control, name: 'goods' });
  const charges = useFieldArray({ control, name: 'charges' });
  const watchedCharges = useWatch({ control, name: 'charges' });
  const rateFor = (id: string) => taxRates.data?.find((t) => t.id === id)?.rate ?? '0';
  const totals = lineTotals([
    ...goods.filter((g) => g.include).map((g) => ({ qty: g.qty, unitCost: g.unitCost, taxRate: g.taxRate })),
    ...watchedCharges.map((c) => ({ qty: c.qty, unitCost: c.unitCost, taxRate: c.taxRateId ? rateFor(c.taxRateId) : '0' })),
  ]);

  const mutation = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        supplierId,
        supplierRef: v.supplierRef,
        invoiceDate: v.invoiceDate,
        dueDate: v.dueDate,
        note: v.note,
        lines: [
          ...v.goods.filter((g) => g.include).map((g) => ({ grnLineId: g.grnLineId, qty: g.qty, unitCost: g.unitCost })),
          ...v.charges.map((c) => ({ accountId: c.accountId, description: c.description, qty: c.qty, unitCost: c.unitCost, taxRateId: c.taxRateId || null })),
        ],
      };
      return existing ? api.put<DataEnvelope<SupplierInvoiceDetail>>(`/supplier-invoices/${existing.id}`, body) : api.post<DataEnvelope<SupplierInvoiceDetail>>('/supplier-invoices', body);
    },
    onSuccess: (res) => {
      toast.success(`Invoice ${res.data.number} saved as a draft. Post it to record the amount owed.`);
      onDone(res.data);
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['supplierRef', 'invoiceDate', 'dueDate', 'note'])),
  });
  const ge = formState.errors.goods;
  const ce = formState.errors.charges;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="inv-ref" label="Supplier's invoice no." error={formState.errors.supplierRef?.message}>
            <Input className="font-mono" {...register('supplierRef')} />
          </Field>
          <Field id="inv-date" label="Invoice date" error={formState.errors.invoiceDate?.message}>
            <Input type="date" {...register('invoiceDate')} />
          </Field>
          <Field id="inv-due" label="Due date" description="Blank = invoice date + payment terms." error={formState.errors.dueDate?.message}>
            <Input type="date" {...register('dueDate')} />
          </Field>
          <Field id="inv-note" label="Note">
            <Textarea rows={1} {...register('note')} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Goods received</CardTitle>
          <CardDescription>Tick what this invoice charges for. A price different from the receipt is booked as purchase price variance.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {ge?.root?.message && <Alert variant="destructive">{ge.root.message}</Alert>}
          {ge?.message && <Alert variant="destructive">{ge.message}</Alert>}
          {openLines.length === 0 && <p className="text-sm text-muted-foreground">Nothing received from this supplier is waiting to be invoiced.</p>}
          {goods.map((g, i) => (
            <div key={g.grnLineId} className="grid items-end gap-3 rounded-md border p-3 md:grid-cols-[auto_1fr_8rem_9rem_7rem]">
              <label className="flex items-center gap-2 self-center">
                <Checkbox aria-label={`Include ${g.label}`} {...register(`goods.${i}.include`)} />
              </label>
              <div>
                <div className="text-sm font-medium">{g.label}</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-mono">{g.receiptNumber}</span> · {formatQty(g.open)} to invoice · received at {formatMoney(g.receiptCost)}
                </div>
              </div>
              <Field id={`ig-${i}-qty`} label="Qty" error={ge?.[i]?.qty?.message}>
                <Input inputMode="decimal" disabled={!g.include} {...register(`goods.${i}.qty`)} />
              </Field>
              <Field id={`ig-${i}-cost`} label="Invoiced price" error={ge?.[i]?.unitCost?.message}>
                <Input inputMode="decimal" disabled={!g.include} {...register(`goods.${i}.unitCost`)} />
              </Field>
              <div className="pb-2 text-right text-xs text-muted-foreground">VAT {Number(g.taxRate)}%</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Other charges</CardTitle>
            <CardDescription>Delivery, services or supplies not held as stock.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => charges.append({ accountId: '', description: '', qty: '1', unitCost: '', taxRateId: '' })}>
            <Plus />
            Add charge
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {charges.fields.map((f, i) => (
            <div key={f.id} className="grid items-end gap-3 rounded-md border p-3 md:grid-cols-[1fr_1fr_6rem_8rem_10rem_auto]">
              <Field id={`ic-${i}-acc`} label="Account" error={ce?.[i]?.accountId?.message}>
                <Select {...register(`charges.${i}.accountId`)}>
                  <option value="">Choose…</option>
                  {expenseAccounts.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={`ic-${i}-desc`} label="Description" error={ce?.[i]?.description?.message}>
                <Input {...register(`charges.${i}.description`)} />
              </Field>
              <Field id={`ic-${i}-qty`} label="Qty" error={ce?.[i]?.qty?.message}>
                <Input inputMode="decimal" {...register(`charges.${i}.qty`)} />
              </Field>
              <Field id={`ic-${i}-cost`} label="Amount (excl. VAT)" error={ce?.[i]?.unitCost?.message}>
                <Input inputMode="decimal" {...register(`charges.${i}.unitCost`)} />
              </Field>
              <Field id={`ic-${i}-tax`} label="VAT">
                <Select {...register(`charges.${i}.taxRateId`)}>
                  <option value="">No VAT</option>
                  {taxRates.data?.filter((t) => t.isActive && t.kind === 'STANDARD').map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({Number(t.rate)}%)
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="ghost" size="sm" aria-label="Remove charge" onClick={() => charges.remove(i)}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <TotalsBox subtotal={totals.subtotal} tax={totals.tax} total={totals.total} />
        </CardContent>
      </Card>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save draft'}
      </Button>
    </form>
  );
}

function InvoiceEditor({ existing, initialSupplierId, onDone }: { existing?: SupplierInvoiceDetail; initialSupplierId?: string; onDone: (i: SupplierInvoiceDetail) => void }) {
  const suppliers = useSupplierOptions();
  const [supplierId, setSupplierId] = useState(existing?.supplier.id ?? initialSupplierId ?? '');
  const open = useQuery({
    queryKey: ['supplier-invoices', 'open-lines', supplierId],
    queryFn: ({ signal }) => api.get<DataEnvelope<OpenReceiptLine[]>>(`/supplier-invoices/open-receipt-lines?supplierId=${supplierId}`, { signal }).then((r) => r.data),
    enabled: Boolean(supplierId),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-5">
          <Field id="inv-supplier" label="Supplier" className="max-w-md">
            <Select disabled={Boolean(existing)} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
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
      {supplierId && open.isPending && <Skeleton className="h-48 w-full" />}
      {open.isError && <Alert variant="destructive">{open.error.message}</Alert>}
      {/* Keyed by supplier: switching supplier starts a fresh form with that supplier's open receipts. */}
      {open.data && <InvoiceForm key={supplierId} supplierId={supplierId} existing={existing} openLines={open.data} onDone={onDone} />}
    </div>
  );
}

function InvoiceView({ invoice }: { invoice: SupplierInvoiceDetail }) {
  const { can } = useAuth();
  const refresh = useRefreshPurchasing();
  const [editing, setEditing] = useState(false);
  const act = async (action: 'post' | 'cancel') => {
    try {
      const res = await api.post<DataEnvelope<SupplierInvoiceDetail>>(`/supplier-invoices/${invoice.id}/${action}`);
      await refresh(KEY, invoice.id, res.data);
      toast.success(action === 'post' ? `${res.data.number} posted — ${formatMoney(res.data.total)} owed to ${res.data.supplier.name}` : 'Invoice cancelled');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    }
  };
  if (editing) return <InvoiceEditor existing={invoice} onDone={(i) => (void refresh(KEY, invoice.id, i), setEditing(false))} />;
  const payable = invoice.status === 'POSTED' || invoice.status === 'PARTIALLY_PAID';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={invoice.status} />
        <div className="ml-auto flex flex-wrap gap-2">
          {invoice.status === 'DRAFT' && can('supplier_invoices.manage') && (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
              <ConfirmAction variant="outline" title={`Cancel ${invoice.number}?`} description="The draft is kept for the record but never posted." confirmLabel="Cancel invoice" destructive onConfirm={() => act('cancel')}>
                Cancel
              </ConfirmAction>
              <ConfirmAction
                title={`Post ${invoice.number}?`}
                description={`Records ${formatMoney(invoice.total)} owed to ${invoice.supplier.name} and matches the goods received. Posted invoices cannot be edited.`}
                confirmLabel="Post invoice"
                onConfirm={() => act('post')}
              >
                Post invoice
              </ConfirmAction>
            </>
          )}
          {payable && can('supplier_payments.manage') && (
            <Link to={`/purchasing/payments/new?supplierId=${invoice.supplier.id}&invoiceId=${invoice.id}`} className={buttonVariants()}>
              <Banknote />
              Record payment
            </Link>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="pt-5">
          <InfoGrid
            items={[
              ['Supplier', <Link key="s" to={`/suppliers/${invoice.supplier.id}`} className="hover:underline">{invoice.supplier.name}</Link>],
              ['Their invoice no.', <span key="r" className="font-mono">{invoice.supplierRef}</span>],
              ['Invoice date', formatDate(invoice.invoiceDate)],
              ['Due', formatDate(invoice.dueDate)],
              ['Created', `${formatDateTime(invoice.createdAt)} · ${invoice.createdBy}`],
              ['Posted', invoice.postedAt ? `${formatDateTime(invoice.postedAt)} · ${invoice.postedBy}` : '—'],
              ['Paid', formatMoney(invoice.amountPaid)],
              ['Outstanding', <strong key="o">{formatMoney(invoice.outstanding)}</strong>],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead className="hidden md:table-cell">Matched to</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">VAT</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.description}</TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{l.receiptNumber ? <span className="font-mono">{l.receiptNumber}</span> : l.account ? `${l.account.code} ${l.account.name}` : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.unitCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.taxAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.netAmount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TotalsBox subtotal={invoice.subtotal} tax={invoice.taxTotal} total={invoice.total} />
        </CardContent>
      </Card>
      {invoice.payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {invoice.payments.map((p) => (
                <li key={p.paymentId} className="flex justify-between py-2">
                  <Link to={`/purchasing/payments/${p.paymentId}`} className="font-mono hover:underline">
                    {p.number}
                  </Link>
                  <span className="text-muted-foreground">{formatDate(p.paymentDate)}</span>
                  <span className="tabular-nums">{formatMoney(p.amount)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function SupplierInvoicePage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const doc = useDocument<SupplierInvoiceDetail>(KEY, '/supplier-invoices', id);
  const supplierParam = params.get('supplierId') ?? undefined;
  return (
    <DocumentShell back={{ to: '/purchasing/invoices', label: 'Supplier invoices' }} title={id ? (doc.data ? `Invoice ${doc.data.number}` : 'Supplier invoice') : 'Enter supplier invoice'} isNew={!id} query={doc}>
      {!id && <InvoiceEditor {...(supplierParam ? { initialSupplierId: supplierParam } : {})} onDone={(i) => navigate(`/purchasing/invoices/${i.id}`, { replace: true })} />}
      {doc.data && <InvoiceView key={doc.data.id} invoice={doc.data} />}
    </DocumentShell>
  );
}
