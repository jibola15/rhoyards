import { useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { PackageCheck, Pencil, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { costInput, positiveQtyInput, type DataEnvelope, type GoodsReceiptDetail, type PurchaseOrderDetail } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
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
import { VariantPicker } from '../../components/VariantPicker';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { useTaxRates } from '../catalog/api';
import { useStoreChoices } from '../../lib/stores';
import { today, useDocument, useRefreshPurchasing, useSupplierOptions } from './api';
import { DocumentShell, InfoGrid, TotalsBox } from './shared';
import { lineTotals } from './totals';

const KEY = 'purchase-orders';

const formSchema = z.object({
  supplierId: z.string().min(1, 'Choose a supplier'),
  locationId: z.string().min(1, 'Choose the delivery location'),
  orderDate: z.string().min(1, 'Enter the order date'),
  expectedDate: z.string(),
  note: z.string().max(1000),
  lines: z
    .array(
      z.object({
        variantId: z.string(),
        label: z.string(),
        sku: z.string(),
        defaultRate: z.string(),
        qty: positiveQtyInput,
        unitCost: costInput,
        taxRateId: z.string(),
      }),
    )
    .min(1, 'Add at least one product'),
});
type FormValues = z.infer<typeof formSchema>;

function PoEditor({ existing, onDone }: { existing?: PurchaseOrderDetail; onDone: (po: PurchaseOrderDetail) => void }) {
  const suppliers = useSupplierOptions();
  const stores = useStoreChoices(existing?.location.id);
  const taxRates = useTaxRates();
  const [formError, setFormError] = useState<string | null>(null);
  const defaultLocation = stores.defaultId;
  const { register, control, handleSubmit, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: existing
      ? {
          supplierId: existing.supplier.id,
          locationId: existing.location.id,
          orderDate: existing.orderDate,
          expectedDate: existing.expectedDate ?? '',
          note: existing.note ?? '',
          lines: existing.lines.map((l) => ({
            variantId: l.variant.id,
            label: `${l.variant.productName} — ${l.variant.name}`,
            sku: l.variant.sku,
            defaultRate: l.taxRate,
            qty: formatQty(l.qtyOrdered),
            unitCost: formatQty(l.unitCost),
            taxRateId: l.taxRateId ?? '',
          })),
        }
      : { supplierId: '', locationId: defaultLocation, orderDate: today(), expectedDate: '', note: '', lines: [] },
    resetOptions: { keepDirtyValues: true },
  });
  const lines = useFieldArray({ control, name: 'lines' });
  const watched = useWatch({ control, name: 'lines' });
  const rateOf = (l: FormValues['lines'][number] | undefined) =>
    l ? (l.taxRateId ? (taxRates.data?.find((t) => t.id === l.taxRateId)?.rate ?? '0') : l.defaultRate) : '0';
  const totals = lineTotals((watched ?? []).map((l) => ({ qty: l.qty, unitCost: l.unitCost, taxRate: rateOf(l) })));

  const mutation = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        supplierId: v.supplierId,
        locationId: v.locationId,
        orderDate: v.orderDate,
        expectedDate: v.expectedDate,
        note: v.note,
        lines: v.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCost: l.unitCost, taxRateId: l.taxRateId || null })),
      };
      return existing ? api.put<DataEnvelope<PurchaseOrderDetail>>(`/purchase-orders/${existing.id}`, body) : api.post<DataEnvelope<PurchaseOrderDetail>>('/purchase-orders', body);
    },
    onSuccess: (res) => {
      toast.success(`Order ${res.data.number} saved as a draft`);
      onDone(res.data);
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['supplierId', 'locationId', 'orderDate', 'expectedDate', 'note'])),
  });
  const le = formState.errors.lines;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="po-supplier" label="Supplier" error={formState.errors.supplierId?.message} className="sm:col-span-2">
            <Select {...register('supplierId')}>
              <option value="">Choose…</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="po-location" label="Deliver to" error={formState.errors.locationId?.message}>
            <Select {...register('locationId')}>
              <option value="">Choose…</option>
              {stores.options.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="po-date" label="Order date" error={formState.errors.orderDate?.message}>
            <Input type="date" {...register('orderDate')} />
          </Field>
          <Field id="po-expected" label="Expected delivery">
            <Input type="date" {...register('expectedDate')} />
          </Field>
          <Field id="po-note" label="Note" className="sm:col-span-2 lg:col-span-3">
            <Textarea rows={1} {...register('note')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <VariantPicker
            onSelect={(v) =>
              lines.append({
                variantId: v.id,
                label: `${v.productName} — ${v.name}`,
                sku: v.sku,
                defaultRate: v.taxRate,
                qty: '',
                unitCost: v.standardCost ? formatQty(v.standardCost) : Number(v.avgCost) > 0 ? formatQty(v.avgCost) : '',
                taxRateId: '',
              })
            }
          />
          {le?.root?.message && <Alert variant="destructive">{le.root.message}</Alert>}
          {le?.message && <Alert variant="destructive">{le.message}</Alert>}
          {lines.fields.map((f, i) => (
            <div key={f.id} className="grid items-end gap-3 rounded-md border p-3 md:grid-cols-[1fr_7rem_9rem_11rem_8rem_auto]">
              <div>
                <div className="text-sm font-medium">{f.label}</div>
                <div className="font-mono text-xs text-muted-foreground">{f.sku}</div>
              </div>
              <Field id={`pl-${i}-qty`} label="Quantity" error={le?.[i]?.qty?.message}>
                <Input inputMode="decimal" {...register(`lines.${i}.qty`)} />
              </Field>
              <Field id={`pl-${i}-cost`} label="Unit cost (excl. VAT)" error={le?.[i]?.unitCost?.message}>
                <Input inputMode="decimal" {...register(`lines.${i}.unitCost`)} />
              </Field>
              <Field id={`pl-${i}-tax`} label="VAT">
                <Select {...register(`lines.${i}.taxRateId`)}>
                  <option value="">Product default ({Number(f.defaultRate)}%)</option>
                  {taxRates.data?.filter((t) => t.isActive).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({Number(t.rate)}%)
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="pb-2 text-right text-sm tabular-nums">{formatMoney(totals.parts[i]?.net.toFixed(2) ?? '0')}</div>
              <Button variant="ghost" size="sm" aria-label={`Remove ${f.label}`} onClick={() => lines.remove(i)}>
                <Trash2 />
              </Button>
            </div>
          ))}
          {lines.fields.length > 0 && <TotalsBox subtotal={totals.subtotal} tax={totals.tax} total={totals.total} />}
        </CardContent>
      </Card>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save draft'}
      </Button>
    </form>
  );
}

function PoView({ po }: { po: PurchaseOrderDetail }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const refresh = useRefreshPurchasing();
  const [editing, setEditing] = useState(false);
  const act = async (action: 'approve' | 'cancel' | 'close') => {
    try {
      const res = await api.post<DataEnvelope<PurchaseOrderDetail>>(`/purchase-orders/${po.id}/${action}`);
      await refresh(KEY, po.id, res.data);
      toast.success({ approve: 'Order approved', cancel: 'Order cancelled', close: 'Order closed' }[action]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    }
  };
  const receive = async () => {
    try {
      const res = await api.post<DataEnvelope<GoodsReceiptDetail>>(`/purchase-orders/${po.id}/receipts`, { receivedDate: today() });
      toast.success(`Draft receipt ${res.data.number} created — check quantities and lots, then post it`);
      navigate(`/purchasing/receipts/${res.data.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the receipt');
    }
  };

  if (editing)
    return (
      <PoEditor
        existing={po}
        onDone={(updated) => {
          void refresh(KEY, po.id, updated);
          setEditing(false);
        }}
      />
    );

  const open = po.status === 'APPROVED' || po.status === 'PARTIALLY_RECEIVED';
  const nothingReceived = po.lines.every((l) => Number(l.qtyReceived) === 0);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={po.status} />
        <div className="ml-auto flex flex-wrap gap-2">
          {po.status === 'DRAFT' && can('purchasing.manage') && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil />
              Edit
            </Button>
          )}
          {(po.status === 'DRAFT' || (po.status === 'APPROVED' && nothingReceived)) && can('purchasing.manage') && (
            <ConfirmAction variant="outline" title={`Cancel ${po.number}?`} description="The order will be kept for the record but can no longer be received." confirmLabel="Cancel order" destructive onConfirm={() => act('cancel')}>
              Cancel order
            </ConfirmAction>
          )}
          {open && !nothingReceived && can('purchasing.manage') && (
            <ConfirmAction variant="outline" title={`Close ${po.number}?`} description="Stop waiting for the quantities still outstanding. What was received stays." confirmLabel="Close order" onConfirm={() => act('close')}>
              Close order
            </ConfirmAction>
          )}
          {po.status === 'DRAFT' && can('purchasing.approve') && (
            <ConfirmAction title={`Approve ${po.number}?`} description={`Commit to buying ${formatMoney(po.total)} from ${po.supplier.name}. The order can no longer be edited.`} confirmLabel="Approve" onConfirm={() => act('approve')}>
              Approve
            </ConfirmAction>
          )}
          {open && can('purchasing.manage') && (
            <Button onClick={() => void receive()}>
              <PackageCheck />
              Receive goods
            </Button>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="pt-5">
          <InfoGrid
            items={[
              ['Supplier', <Link key="s" to={`/suppliers/${po.supplier.id}`} className="hover:underline">{po.supplier.name}</Link>],
              ['Deliver to', po.location.name],
              ['Order date', formatDate(po.orderDate)],
              ['Expected', formatDate(po.expectedDate)],
              ['Created', `${formatDateTime(po.createdAt)} · ${po.createdBy}`],
              ['Approved', po.approvedAt ? `${formatDateTime(po.approvedAt)} · ${po.approvedBy}` : '—'],
              ...(po.endedAt ? ([[po.status === 'CANCELLED' ? 'Cancelled' : 'Closed', `${formatDateTime(po.endedAt)} · ${po.endedBy}`]] as [string, string][]) : []),
              ...(po.note ? ([['Note', po.note]] as [string, string][]) : []),
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">VAT</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {po.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="font-medium">{l.variant.productName}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name} · <span className="font-mono">{l.variant.sku}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qtyOrdered)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qtyReceived)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qtyOutstanding)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.unitCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.taxRate)}%</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.netAmount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TotalsBox subtotal={po.subtotal} tax={po.taxTotal} total={po.total} />
        </CardContent>
      </Card>
      {po.receipts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Receipts</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {po.receipts.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <Link to={`/purchasing/receipts/${r.id}`} className="font-mono hover:underline">
                    {r.number}
                  </Link>
                  <span className="text-muted-foreground">{formatDate(r.receivedDate)}</span>
                  <span className="tabular-nums">{r.status === 'POSTED' ? formatMoney(r.totalValue) : '—'}</span>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function PurchaseOrderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const doc = useDocument<PurchaseOrderDetail>(KEY, '/purchase-orders', id);
  return (
    <DocumentShell back={{ to: '/purchasing/orders', label: 'Purchase orders' }} title={id ? (doc.data ? `Purchase order ${doc.data.number}` : 'Purchase order') : 'New purchase order'} isNew={!id} query={doc}>
      {!id && <PoEditor onDone={(po) => navigate(`/purchasing/orders/${po.id}`, { replace: true })} />}
      {doc.data && <PoView key={doc.data.id} po={doc.data} />}
    </DocumentShell>
  );
}
