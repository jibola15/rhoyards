import { useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { positiveQtyInput, type DataEnvelope, type TransferDetail } from '@rhoyards/shared';
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
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader, QueryError } from '../../components/page';
import { StatusBadge } from '../../components/StatusBadge';
import { VariantPicker } from '../../components/VariantPicker';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatQty } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { useLocations } from '../users/api';
import { STOCK_KEYS, useTransfer } from './api';

const formSchema = z
  .object({
    fromLocationId: z.string().min(1, 'Choose the source'),
    toLocationId: z.string().min(1, 'Choose the destination'),
    note: z.string().max(1000),
    lines: z
      .array(z.object({ variantId: z.string(), label: z.string(), sku: z.string(), onHand: z.string().nullable(), qty: positiveQtyInput }))
      .min(1, 'Add at least one product'),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, { message: 'Source and destination must differ', path: ['toLocationId'] });
type FormValues = z.infer<typeof formSchema>;

function TransferEditor({ existing, onSaved, onCancel }: { existing?: TransferDetail; onSaved?: (t: TransferDetail) => void; onCancel: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const locations = useLocations();
  const [formError, setFormError] = useState<string | null>(null);
  const active = locations.data?.filter((l) => l.isActive) ?? [];
  const { register, control, handleSubmit, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: existing
      ? {
          fromLocationId: existing.fromLocation.id,
          toLocationId: existing.toLocation.id,
          note: existing.note ?? '',
          lines: existing.lines.map((l) => ({
            variantId: l.variant.id,
            label: `${l.variant.productName} — ${l.variant.name}`,
            sku: l.variant.sku,
            onHand: null,
            qty: formatQty(l.qty),
          })),
        }
      : { fromLocationId: '', toLocationId: '', note: '', lines: [] },
  });
  const lines = useFieldArray({ control, name: 'lines' });
  const fromLocationId = useWatch({ control, name: 'fromLocationId' });

  const mutation = useMutation({
    mutationFn: (v: FormValues) => {
      const body = { fromLocationId: v.fromLocationId, toLocationId: v.toLocationId, note: v.note, lines: v.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })) };
      return existing
        ? api.put<DataEnvelope<TransferDetail>>(`/stock-transfers/${existing.id}`, body)
        : api.post<DataEnvelope<TransferDetail>>('/stock-transfers', body);
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['stock-transfers'] });
      toast.success(`Draft ${res.data.number} saved. Dispatch it when the stock leaves.`);
      if (onSaved) onSaved(res.data);
      else navigate(`/inventory/transfers/${res.data.id}`, { replace: true });
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, ['fromLocationId', 'toLocationId', 'note'])),
  });
  const le = formState.errors.lines;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <Field id="tr-from" label="From" error={formState.errors.fromLocationId?.message}>
            <Select {...register('fromLocationId')}>
              <option value="">Choose…</option>
              {active.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="tr-to" label="To" error={formState.errors.toLocationId?.message}>
            <Select {...register('toLocationId')}>
              <option value="">Choose…</option>
              {active.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="tr-note" label="Note" className="sm:col-span-2">
            <Textarea rows={2} {...register('note')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <VariantPicker
            locationId={fromLocationId || undefined}
            onSelect={(v) => lines.append({ variantId: v.id, label: `${v.productName} — ${v.name}`, sku: v.sku, onHand: v.qtyAvailable, qty: '' })}
          />
          {le?.root?.message && <Alert variant="destructive">{le.root.message}</Alert>}
          {le?.message && <Alert variant="destructive">{le.message}</Alert>}
          {lines.fields.map((f, i) => (
            <div key={f.id} className="grid items-end gap-3 rounded-md border p-3 sm:grid-cols-[1fr_8rem_auto]">
              <div>
                <div className="text-sm font-medium">{f.label}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {f.sku}
                  {f.onHand !== null && ` · ${formatQty(f.onHand)} available at source`}
                </div>
              </div>
              <Field id={`tl-${i}-qty`} label="Quantity" error={le?.[i]?.qty?.message}>
                <Input inputMode="decimal" {...register(`lines.${i}.qty`)} />
              </Field>
              <Button variant="ghost" size="sm" aria-label={`Remove ${f.label}`} onClick={() => lines.remove(i)}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TransferView({ transfer }: { transfer: TransferDetail }) {
  const { can } = useAuth();
  const canTransfer = can('inventory.transfer');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'dispatch' | 'receive' | 'cancel' | null>(null);

  const refresh = async (t: TransferDetail) => {
    queryClient.setQueryData(['stock-transfers', 'detail', t.id], t);
    await queryClient.invalidateQueries({ queryKey: ['stock-transfers', 'list'] });
    for (const key of STOCK_KEYS) void queryClient.invalidateQueries({ queryKey: key });
  };
  const act = async (action: 'dispatch' | 'receive' | 'cancel') => {
    try {
      const res = await api.post<DataEnvelope<TransferDetail>>(`/stock-transfers/${transfer.id}/${action}`);
      await refresh(res.data);
      toast.success({ dispatch: 'Dispatched — stock is in transit', receive: 'Received — stock is at the destination', cancel: 'Transfer cancelled' }[action]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    }
  };

  if (editing) {
    return (
      <TransferEditor
        existing={transfer}
        onSaved={(t) => {
          void refresh(t);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const copy = {
    dispatch: { title: `Dispatch ${transfer.number}?`, description: `Stock leaves ${transfer.fromLocation.name} now (earliest-expiring lots first; expired lots are not sent).`, label: 'Dispatch' },
    receive: { title: `Receive ${transfer.number}?`, description: `Confirm the goods arrived at ${transfer.toLocation.name}. Stock becomes available there.`, label: 'Receive' },
    cancel: { title: `Cancel ${transfer.number}?`, description: 'The draft is kept for the record but can no longer be dispatched.', label: 'Cancel transfer' },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={transfer.status} />
        <span className="text-sm text-muted-foreground">
          {transfer.fromLocation.name} → {transfer.toLocation.name}
        </span>
        {canTransfer && (
          <div className="ml-auto flex gap-2">
            {transfer.status === 'DRAFT' && (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil />
                  Edit
                </Button>
                <Button variant="outline" onClick={() => setConfirm('cancel')}>
                  Cancel
                </Button>
                <Button onClick={() => setConfirm('dispatch')}>Dispatch</Button>
              </>
            )}
            {transfer.status === 'DISPATCHED' && <Button onClick={() => setConfirm('receive')}>Mark received</Button>}
          </div>
        )}
      </div>
      <Card>
        <CardContent className="grid gap-4 pt-5 text-sm sm:grid-cols-3">
          <div>
            <div className="text-muted-foreground">Created</div>
            {formatDateTime(transfer.createdAt)} · {transfer.createdBy}
          </div>
          <div>
            <div className="text-muted-foreground">Dispatched</div>
            {formatDateTime(transfer.dispatchedAt)}
          </div>
          <div>
            <div className="text-muted-foreground">Received</div>
            {formatDateTime(transfer.receivedAt)}
          </div>
          {transfer.note && <div className="sm:col-span-3">{transfer.note}</div>}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Lots</TableHead>
                <TableHead className="text-right">Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfer.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="font-medium">{l.variant.productName}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name} · <span className="font-mono">{l.variant.sku}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {l.batches.length === 0
                      ? transfer.status === 'DRAFT'
                        ? 'Picked at dispatch'
                        : '—'
                      : l.batches.map((b) => (
                          <div key={b.lotNumber}>
                            <span className="font-mono">{b.lotNumber}</span> × {formatQty(b.qty)}
                            {b.expiryDate && <span className="text-muted-foreground"> · exp. {formatDate(b.expiryDate)}</span>}
                          </div>
                        ))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qty)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={copy[confirm].title}
          description={copy[confirm].description}
          confirmLabel={copy[confirm].label}
          destructive={confirm === 'cancel'}
          onConfirm={() => act(confirm)}
        />
      )}
    </div>
  );
}

export function TransferPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const transfer = useTransfer(id);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link to="/inventory/transfers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Stock transfers
      </Link>
      <PageHeader title={id ? (transfer.data ? `Transfer ${transfer.data.number}` : 'Transfer') : 'New stock transfer'} />
      {!id && <TransferEditor onCancel={() => navigate('/inventory/transfers')} />}
      {id && transfer.isPending && <Skeleton className="h-64 w-full" />}
      {id && transfer.isError && <QueryError error={transfer.error} onRetry={() => void transfer.refetch()} />}
      {transfer.data && <TransferView key={transfer.data.id} transfer={transfer.data} />}
    </div>
  );
}
