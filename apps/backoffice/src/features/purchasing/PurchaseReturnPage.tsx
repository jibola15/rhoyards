import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Pencil } from 'lucide-react';
import { z } from 'zod';
import { qtyInput, type DataEnvelope, type GoodsReceiptDetail, type PurchaseReturnDetail } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
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
import { today, useDocument, useRefreshPurchasing } from './api';
import { DocumentShell, InfoGrid } from './shared';

const KEY = 'purchase-returns';

const formSchema = z
  .object({
    returnDate: z.string().min(1, 'Enter the return date'),
    reason: z.string().max(200),
    note: z.string().max(1000),
    lines: z.array(z.object({ grnLineId: z.string(), label: z.string(), lot: z.string(), returnable: z.string(), qty: z.union([z.literal(''), qtyInput]) })),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      if (l.qty && Number(l.qty) > Number(l.returnable)) ctx.addIssue({ code: 'custom', path: ['lines', i, 'qty'], message: `At most ${formatQty(l.returnable)}` });
    });
    if (!v.lines.some((l) => l.qty && Number(l.qty) > 0)) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Enter a quantity for at least one product' });
  });
type FormValues = z.infer<typeof formSchema>;

function ReturnForm({ receipt, existing, onDone }: { receipt: GoodsReceiptDetail; existing?: PurchaseReturnDetail | undefined; onDone: (r: PurchaseReturnDetail) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const current = new Map((existing?.lines ?? []).map((l) => [l.grnLineId, l.qty]));
  const { register, handleSubmit, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      returnDate: existing?.returnDate ?? today(),
      reason: existing?.reason ?? '',
      note: existing?.note ?? '',
      lines: receipt.lines.map((l) => ({
        grnLineId: l.id,
        label: `${l.variant.productName} — ${l.variant.name}`,
        lot: l.lotNumber ?? '',
        returnable: (Number(l.qty) - Number(l.qtyReturned)).toFixed(3),
        qty: current.has(l.id) ? formatQty(current.get(l.id)!) : '',
      })),
    },
  });
  const mutation = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        receiptId: receipt.id,
        returnDate: v.returnDate,
        reason: v.reason,
        note: v.note,
        lines: v.lines.filter((l) => l.qty && Number(l.qty) > 0).map((l) => ({ grnLineId: l.grnLineId, qty: l.qty })),
      };
      return existing ? api.put<DataEnvelope<PurchaseReturnDetail>>(`/purchase-returns/${existing.id}`, body) : api.post<DataEnvelope<PurchaseReturnDetail>>('/purchase-returns', body);
    },
    onSuccess: (res) => {
      toast.success(`Return ${res.data.number} saved. Post it when the goods leave.`);
      onDone(res.data);
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['returnDate', 'reason', 'note'])),
  });
  const le = formState.errors.lines;
  const lines = receipt.lines;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-3">
          <Field id="ret-date" label="Return date" error={formState.errors.returnDate?.message}>
            <Input type="date" {...register('returnDate')} />
          </Field>
          <Field id="ret-reason" label="Reason" className="sm:col-span-2">
            <Input placeholder="e.g. Damaged on arrival, wrong shade delivered" {...register('reason')} />
          </Field>
          <Field id="ret-note" label="Note" className="sm:col-span-3">
            <Textarea rows={1} {...register('note')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Goods from {receipt.number}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {le?.root?.message && <Alert variant="destructive">{le.root.message}</Alert>}
          {lines.map((l, i) => (
            <div key={l.id} className="grid items-end gap-3 rounded-md border p-3 sm:grid-cols-[1fr_9rem]">
              <div className="text-sm">
                <div className="font-medium">
                  {l.variant.productName} — {l.variant.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {l.lotNumber && <span className="font-mono">Lot {l.lotNumber} · </span>}
                  received {formatQty(l.qty)}, returned {formatQty(l.qtyReturned)}
                </div>
              </div>
              <Field id={`rl-${i}`} label="Qty to return" error={le?.[i]?.qty?.message}>
                <Input inputMode="decimal" {...register(`lines.${i}.qty`)} />
              </Field>
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

function NewReturn({ receiptId }: { receiptId: string }) {
  const navigate = useNavigate();
  const receipt = useDocument<GoodsReceiptDetail>('goods-receipts', '/goods-receipts', receiptId);
  if (receipt.isError) return <Alert variant="destructive">{receipt.error.message}</Alert>;
  if (!receipt.data) return null;
  if (receipt.data.status !== 'POSTED') return <Alert variant="destructive">Only posted receipts can be returned against.</Alert>;
  return <ReturnForm receipt={receipt.data} onDone={(r) => navigate(`/purchasing/returns/${r.id}`, { replace: true })} />;
}

function ReturnView({ ret }: { ret: PurchaseReturnDetail }) {
  const { can } = useAuth();
  const refresh = useRefreshPurchasing();
  const [editing, setEditing] = useState(false);
  const receipt = useDocument<GoodsReceiptDetail>('goods-receipts', '/goods-receipts', editing ? ret.receipt.id : undefined);
  const act = async (action: 'post' | 'cancel') => {
    try {
      const res = await api.post<DataEnvelope<PurchaseReturnDetail>>(`/purchase-returns/${ret.id}/${action}`);
      await refresh(KEY, ret.id, res.data);
      toast.success(action === 'post' ? `${res.data.number} posted — stock removed${Number(res.data.creditTotal) > 0 ? `, ${formatMoney(res.data.creditTotal)} due back from the supplier` : ''}` : 'Return cancelled');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    }
  };
  if (editing && receipt.data) return <ReturnForm receipt={receipt.data} existing={ret} onDone={(r) => (void refresh(KEY, ret.id, r), setEditing(false))} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={ret.status} />
        {ret.status === 'DRAFT' && can('purchasing.manage') && (
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil />
              Edit
            </Button>
            <ConfirmAction variant="outline" title={`Cancel ${ret.number}?`} description="The draft is kept for the record; no stock moves." confirmLabel="Cancel return" destructive onConfirm={() => act('cancel')}>
              Cancel
            </ConfirmAction>
            <ConfirmAction
              title={`Post ${ret.number}?`}
              description="The goods leave stock now. Goods already invoiced become a credit due from the supplier."
              confirmLabel="Post return"
              onConfirm={() => act('post')}
            >
              Post return
            </ConfirmAction>
          </div>
        )}
      </div>
      <Card>
        <CardContent className="pt-5">
          <InfoGrid
            items={[
              ['Supplier', <Link key="s" to={`/suppliers/${ret.supplier.id}`} className="hover:underline">{ret.supplier.name}</Link>],
              ['Receipt', <Link key="g" to={`/purchasing/receipts/${ret.receipt.id}`} className="font-mono hover:underline">{ret.receipt.number}</Link>],
              ['Return date', formatDate(ret.returnDate)],
              ['Reason', ret.reason ?? '—'],
              ['Created', `${formatDateTime(ret.createdAt)} · ${ret.createdBy}`],
              ['Posted', ret.postedAt ? `${formatDateTime(ret.postedAt)} · ${ret.postedBy}` : '—'],
              ['Supplier credit', ret.status === 'POSTED' ? formatMoney(ret.creditTotal) : '—'],
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
                <TableHead>Lot</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Stock value</TableHead>
                <TableHead className="text-right">Supplier credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ret.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.variant.productName} — {l.variant.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{l.lotNumber ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ret.status === 'POSTED' ? formatMoney(l.stockValue) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{ret.status === 'POSTED' ? formatMoney(l.creditValue) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function PurchaseReturnPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const doc = useDocument<PurchaseReturnDetail>(KEY, '/purchase-returns', id);
  const receiptId = params.get('receiptId');
  return (
    <DocumentShell back={{ to: '/purchasing/returns', label: 'Returns to suppliers' }} title={id ? (doc.data ? `Return ${doc.data.number}` : 'Return') : 'Return goods to supplier'} isNew={!id} query={doc}>
      {!id && (receiptId ? <NewReturn receiptId={receiptId} /> : <Alert>Open the goods receipt the items arrived on and choose “Return goods”.</Alert>)}
      {doc.data && <ReturnView key={doc.data.id} ret={doc.data} />}
    </DocumentShell>
  );
}
