import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { FileText, Pencil, Trash2, Undo2 } from 'lucide-react';
import { z } from 'zod';
import { costInput, positiveQtyInput, type DataEnvelope, type GoodsReceiptDetail } from '@rhoyards/shared';
import {
  Alert,
  Button,
  buttonVariants,
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
import { useLocations } from '../users/api';
import { today, useDocument, useRefreshPurchasing, useSupplierOptions } from './api';
import { DocumentShell, InfoGrid } from './shared';

const KEY = 'goods-receipts';

const formSchema = z.object({
  supplierId: z.string().min(1, 'Choose a supplier'),
  locationId: z.string().min(1, 'Choose the receiving location'),
  receivedDate: z.string().min(1, 'Enter the date received'),
  supplierRef: z.string().max(60),
  note: z.string().max(1000),
  lines: z
    .array(
      z
        .object({
          poLineId: z.string(),
          variantId: z.string(),
          label: z.string(),
          sku: z.string(),
          isBatchTracked: z.boolean(),
          isExpiryTracked: z.boolean(),
          qty: positiveQtyInput,
          unitCost: costInput,
          taxRateId: z.string(),
          lotNumber: z.string().max(60),
          expiryDate: z.string(),
        })
        .superRefine((l, ctx) => {
          if (l.isExpiryTracked && !l.expiryDate) ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: 'Expiry date required' });
          if (l.isBatchTracked && !l.isExpiryTracked && !l.lotNumber) ctx.addIssue({ code: 'custom', path: ['lotNumber'], message: 'Lot number required' });
        }),
    )
    .min(1, 'Add at least one product'),
});
type FormValues = z.infer<typeof formSchema>;

function GrnEditor({ existing, onDone }: { existing?: GoodsReceiptDetail; onDone: (g: GoodsReceiptDetail) => void }) {
  const suppliers = useSupplierOptions();
  const locations = useLocations();
  const [formError, setFormError] = useState<string | null>(null);
  const fromPo = Boolean(existing?.po);
  const defaultLocation = locations.data?.find((l) => l.isActive && l.isPosEnabled)?.id ?? '';
  const { register, control, handleSubmit, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: existing
      ? {
          supplierId: existing.supplier.id,
          locationId: existing.location.id,
          receivedDate: existing.receivedDate,
          supplierRef: existing.supplierRef ?? '',
          note: existing.note ?? '',
          lines: existing.lines.map((l) => ({
            poLineId: l.poLineId ?? '',
            variantId: l.variant.id,
            label: `${l.variant.productName} — ${l.variant.name}`,
            sku: l.variant.sku,
            isBatchTracked: l.variant.isBatchTracked,
            isExpiryTracked: l.variant.isExpiryTracked,
            qty: formatQty(l.qty),
            unitCost: formatQty(l.unitCost),
            taxRateId: l.taxRateId ?? '',
            lotNumber: l.lotNumber ?? '',
            expiryDate: l.expiryDate ?? '',
          })),
        }
      : { supplierId: '', locationId: defaultLocation, receivedDate: today(), supplierRef: '', note: '', lines: [] },
    resetOptions: { keepDirtyValues: true },
  });
  const lines = useFieldArray({ control, name: 'lines' });

  const mutation = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        supplierId: v.supplierId,
        locationId: v.locationId,
        poId: existing?.po?.id ?? null,
        receivedDate: v.receivedDate,
        supplierRef: v.supplierRef,
        note: v.note,
        lines: v.lines.map((l) => ({
          poLineId: l.poLineId || null,
          variantId: l.variantId,
          qty: l.qty,
          unitCost: l.unitCost,
          taxRateId: l.taxRateId || null,
          lotNumber: l.lotNumber,
          expiryDate: l.expiryDate,
        })),
      };
      return existing ? api.put<DataEnvelope<GoodsReceiptDetail>>(`/goods-receipts/${existing.id}`, body) : api.post<DataEnvelope<GoodsReceiptDetail>>('/goods-receipts', body);
    },
    onSuccess: (res) => {
      toast.success(`Receipt ${res.data.number} saved. Post it to put the stock on the shelf.`);
      onDone(res.data);
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['supplierId', 'locationId', 'receivedDate', 'supplierRef', 'note'])),
  });
  const le = formState.errors.lines;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="grn-supplier" label="Supplier" error={formState.errors.supplierId?.message} className="sm:col-span-2">
            <Select disabled={fromPo} {...register('supplierId')}>
              <option value="">Choose…</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="grn-location" label="Received at" error={formState.errors.locationId?.message}>
            <Select disabled={fromPo} {...register('locationId')}>
              <option value="">Choose…</option>
              {locations.data?.filter((l) => l.isActive).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="grn-date" label="Date received" error={formState.errors.receivedDate?.message}>
            <Input type="date" {...register('receivedDate')} />
          </Field>
          <Field id="grn-ref" label="Delivery note / waybill no.">
            <Input {...register('supplierRef')} />
          </Field>
          <Field id="grn-note" label="Note" className="sm:col-span-2 lg:col-span-3">
            <Textarea rows={1} {...register('note')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Goods received</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!fromPo && (
            <VariantPicker
              onSelect={(v) =>
                lines.append({
                  poLineId: '',
                  variantId: v.id,
                  label: `${v.productName} — ${v.name}`,
                  sku: v.sku,
                  isBatchTracked: v.isBatchTracked,
                  isExpiryTracked: v.isExpiryTracked,
                  qty: '',
                  unitCost: v.standardCost ? formatQty(v.standardCost) : '',
                  taxRateId: '',
                  lotNumber: '',
                  expiryDate: '',
                })
              }
            />
          )}
          {fromPo && <p className="text-sm text-muted-foreground">Lines come from order {existing!.po!.number}. Reduce a quantity if less arrived.</p>}
          {le?.root?.message && <Alert variant="destructive">{le.root.message}</Alert>}
          {le?.message && <Alert variant="destructive">{le.message}</Alert>}
          {lines.fields.map((f, i) => (
            <div key={f.id} className="grid items-end gap-3 rounded-md border p-3 md:grid-cols-12">
              <div className="md:col-span-4">
                <div className="text-sm font-medium">{f.label}</div>
                <div className="font-mono text-xs text-muted-foreground">{f.sku}</div>
              </div>
              <Field id={`gl-${i}-qty`} label="Qty received" error={le?.[i]?.qty?.message} className="md:col-span-2">
                <Input inputMode="decimal" {...register(`lines.${i}.qty`)} />
              </Field>
              <Field id={`gl-${i}-cost`} label="Unit cost (excl. VAT)" error={le?.[i]?.unitCost?.message} className="md:col-span-2">
                <Input inputMode="decimal" {...register(`lines.${i}.unitCost`)} />
              </Field>
              {f.isBatchTracked ? (
                <>
                  <Field id={`gl-${i}-lot`} label="Lot no." error={le?.[i]?.lotNumber?.message} className="md:col-span-2">
                    <Input className="font-mono" {...register(`lines.${i}.lotNumber`)} />
                  </Field>
                  {f.isExpiryTracked ? (
                    <Field id={`gl-${i}-exp`} label="Expiry" error={le?.[i]?.expiryDate?.message} className="md:col-span-2">
                      <Input type="date" {...register(`lines.${i}.expiryDate`)} />
                    </Field>
                  ) : (
                    <div className="md:col-span-2" />
                  )}
                </>
              ) : (
                <div className="md:col-span-4" />
              )}
              {!fromPo && (
                <div className="md:col-span-12 md:flex md:justify-end">
                  <Button variant="ghost" size="sm" aria-label={`Remove ${f.label}`} onClick={() => lines.remove(i)}>
                    <Trash2 />
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save draft'}
      </Button>
    </form>
  );
}

function GrnView({ grn }: { grn: GoodsReceiptDetail }) {
  const { can } = useAuth();
  const refresh = useRefreshPurchasing();
  const [editing, setEditing] = useState(false);
  const act = async (action: 'post' | 'cancel') => {
    try {
      const res = await api.post<DataEnvelope<GoodsReceiptDetail>>(`/goods-receipts/${grn.id}/${action}`);
      await refresh(KEY, grn.id, res.data);
      toast.success(action === 'post' ? `${res.data.number} posted — ${formatMoney(res.data.totalValue)} added to stock` : 'Receipt cancelled');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    }
  };
  if (editing)
    return (
      <GrnEditor
        existing={grn}
        onDone={(g) => {
          void refresh(KEY, grn.id, g);
          setEditing(false);
        }}
      />
    );

  const canManage = can('purchasing.manage');
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={grn.status} />
        <div className="ml-auto flex flex-wrap gap-2">
          {grn.status === 'DRAFT' && canManage && (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
              <ConfirmAction variant="outline" title={`Cancel ${grn.number}?`} description="The draft is kept for the record but nothing is added to stock." confirmLabel="Cancel receipt" destructive onConfirm={() => act('cancel')}>
                Cancel
              </ConfirmAction>
              <ConfirmAction
                title={`Post ${grn.number}?`}
                description="The goods are added to stock at the costs shown and the purchase order is updated. Posted receipts cannot be edited."
                confirmLabel="Post receipt"
                onConfirm={() => act('post')}
              >
                Post receipt
              </ConfirmAction>
            </>
          )}
          {grn.status === 'POSTED' && can('supplier_invoices.manage') && grn.lines.some((l) => Number(l.qtyInvoiceable) > 0) && (
            <Link to={`/purchasing/invoices/new?supplierId=${grn.supplier.id}`} className={buttonVariants({ variant: 'outline' })}>
              <FileText />
              Enter supplier invoice
            </Link>
          )}
          {grn.status === 'POSTED' && canManage && (
            <Link to={`/purchasing/returns/new?receiptId=${grn.id}`} className={buttonVariants({ variant: 'outline' })}>
              <Undo2 />
              Return goods
            </Link>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="pt-5">
          <InfoGrid
            items={[
              ['Supplier', <Link key="s" to={`/suppliers/${grn.supplier.id}`} className="hover:underline">{grn.supplier.name}</Link>],
              ['Received at', grn.location.name],
              ['Date received', formatDate(grn.receivedDate)],
              ['Order', grn.po ? <Link key="po" to={`/purchasing/orders/${grn.po.id}`} className="font-mono hover:underline">{grn.po.number}</Link> : 'Direct delivery'],
              ['Delivery note', grn.supplierRef ?? '—'],
              ['Created', `${formatDateTime(grn.createdAt)} · ${grn.createdBy}`],
              ['Posted', grn.postedAt ? `${formatDateTime(grn.postedAt)} · ${grn.postedBy}` : '—'],
              ['Value', grn.status === 'POSTED' ? formatMoney(grn.totalValue) : '—'],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Lot / expiry</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="hidden text-right md:table-cell">Invoiced</TableHead>
                <TableHead className="hidden text-right md:table-cell">Returned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grn.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="font-medium">{l.variant.productName}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name} · <span className="font-mono">{l.variant.sku}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {l.lotNumber ? <span className="font-mono">{l.lotNumber}</span> : '—'}
                    {l.expiryDate && <div className="text-muted-foreground">Exp. {formatDate(l.expiryDate)}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.unitCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{grn.status === 'POSTED' ? formatMoney(l.value) : '—'}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatQty(l.qtyInvoiced)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatQty(l.qtyReturned)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function GoodsReceiptPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const doc = useDocument<GoodsReceiptDetail>(KEY, '/goods-receipts', id);
  return (
    <DocumentShell back={{ to: '/purchasing/receipts', label: 'Goods received' }} title={id ? (doc.data ? `Goods receipt ${doc.data.number}` : 'Goods receipt') : 'Receive goods (no order)'} isNew={!id} query={doc}>
      {!id && <GrnEditor onDone={(g) => navigate(`/purchasing/receipts/${g.id}`, { replace: true })} />}
      {doc.data && <GrnView key={doc.data.id} grn={doc.data} />}
    </DocumentShell>
  );
}
