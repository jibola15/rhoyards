import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONDITION_LABELS,
  dec,
  ITEM_CONDITIONS,
  type DataEnvelope,
  type ItemCondition,
  type ReturnableSale,
  type ReturnDetail,
  type ReturnSummary,
} from '@rhoyards/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { DocumentList } from '../../components/DocumentList';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { DocumentShell, InfoGrid } from '../purchasing/shared';
import { usePaymentMethods } from './api';

const STATUSES = [
  { value: 'PENDING_APPROVAL', label: 'Awaiting approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'COMPLETED', label: 'Refunded' },
  { value: 'REJECTED', label: 'Rejected' },
];

export function ReturnsPage() {
  return (
    <DocumentList<ReturnSummary>
      title="Returns"
      description="Goods brought back by customers. Start a return from the sale; refunds are paid once a return is approved."
      queryKey="returns"
      path="/returns"
      statuses={STATUSES}
      searchPlaceholder="Search by return or sale number, or customer"
      columns={[
        {
          header: 'Return',
          cell: (r) => (
            <Link to={`/returns/${r.id}`} className="font-mono font-medium hover:underline">
              {r.number}
            </Link>
          ),
        },
        { header: 'Requested', cell: (r) => formatDateTime(r.requestedAt), className: 'hidden md:table-cell' },
        { header: 'Sale', cell: (r) => <span className="font-mono">{r.sale.number}</span> },
        { header: 'Customer', cell: (r) => r.customer?.name ?? 'Walk-in', className: 'hidden lg:table-cell' },
        { header: 'Total', cell: (r) => formatMoney(r.total), className: 'text-right tabular-nums' },
        { header: 'Status', cell: (r) => <StatusBadge status={r.status === 'COMPLETED' ? 'REFUNDED' : r.status} /> },
      ]}
    />
  );
}

type LineState = { qty: string; condition: ItemCondition; restock: boolean };

export function NewReturnPage() {
  const [params] = useSearchParams();
  const saleId = params.get('saleId') ?? '';
  const navigate = useNavigate();
  const { can } = useAuth();
  const sale = useQuery({
    queryKey: ['returnable', saleId],
    queryFn: ({ signal }) => api.get<DataEnvelope<ReturnableSale>>(`/sales/${saleId}/returnable`, { signal }).then((r) => r.data),
    enabled: Boolean(saleId),
  });
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [reason, setReason] = useState('');
  const [refundShipping, setRefundShipping] = useState(false);
  const [approve, setApprove] = useState(can('returns.approve'));
  const [error, setError] = useState<string | null>(null);
  const line = (id: string): LineState => lines[id] ?? { qty: '', condition: 'RESALEABLE', restock: true };
  const set = (id: string, patch: Partial<LineState>) => setLines((s) => ({ ...s, [id]: { ...line(id), ...patch } }));
  const chosen = Object.entries(lines).filter(([, l]) => l.qty && Number(l.qty) > 0);

  const create = useMutation({
    mutationFn: () =>
      api.post<DataEnvelope<ReturnDetail>>('/returns', {
        saleId,
        reason,
        refundShipping,
        approve,
        lines: chosen.map(([saleItemId, l]) => ({ saleItemId, qty: l.qty, condition: l.condition, restock: l.condition === 'RESALEABLE' && l.restock })),
      }),
    onSuccess: (res) => {
      toast.success(`Return ${res.data.number} ${res.data.status === 'APPROVED' ? 'approved' : 'sent for approval'}`);
      navigate(`/returns/${res.data.id}`, { replace: true });
    },
    onError: (e) => setError(e.message),
  });

  return (
    <DocumentShell back={{ to: '/returns', label: 'Returns' }} title="New return" isNew query={sale}>
      {!saleId && <Alert>Open the sale being returned and choose “Return items”.</Alert>}
      {sale.isPending && saleId && <Skeleton className="h-64 w-full" />}
      {sale.isError && <Alert variant="destructive">{sale.error.message}</Alert>}
      {sale.data && (
        <div className="space-y-6">
          {error && <Alert variant="destructive">{error}</Alert>}
          <Card>
            <CardContent className="pt-5">
              <InfoGrid
                items={[
                  ['Sale', <Link key="s" to={`/sales/${sale.data.sale.id}`} className="font-mono hover:underline">{sale.data.sale.number}</Link>],
                  ['Sold', formatDateTime(sale.data.sale.completedAt)],
                  ['Customer', sale.data.sale.customer?.name ?? 'Walk-in'],
                  ['Still owed on the sale', formatMoney(sale.data.sale.outstanding)],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Can return</TableHead>
                    <TableHead className="w-28">Return</TableHead>
                    <TableHead className="w-48">Condition</TableHead>
                    <TableHead className="w-24">To stock</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sale.data.lines.map((l) => {
                    const st = line(l.saleItemId);
                    const left = dec(l.returnable);
                    return (
                      <TableRow key={l.saleItemId}>
                        <TableCell>
                          {l.description}
                          <span className="block text-xs text-muted-foreground">
                            {formatQty(l.qty)} sold at {formatMoney(l.unitPrice)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatQty(l.returnable)}</TableCell>
                        <TableCell>
                          <Input aria-label={`Quantity of ${l.description} to return`} inputMode="decimal" disabled={left.lte(0)} value={st.qty} onChange={(e) => set(l.saleItemId, { qty: e.target.value })} />
                        </TableCell>
                        <TableCell>
                          <Select aria-label={`Condition of ${l.description}`} value={st.condition} onChange={(e) => set(l.saleItemId, { condition: e.target.value as ItemCondition })}>
                            {ITEM_CONDITIONS.map((c) => (
                              <option key={c} value={c}>
                                {CONDITION_LABELS[c]}
                              </option>
                            ))}
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Checkbox aria-label={`Put ${l.description} back in stock`} disabled={st.condition !== 'RESALEABLE'} checked={st.condition === 'RESALEABLE' && st.restock} onChange={(e) => set(l.saleItemId, { restock: e.target.checked })} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <p className="mt-3 text-xs text-muted-foreground">Items put back in stock return at the cost they were sold at. Damaged, opened or expired items are not restocked.</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-4 pt-5">
              <Field id="ret-reason" label="Reason">
                <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              {dec(sale.data.shippingRefundable).gt(0) && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={refundShipping} onChange={(e) => setRefundShipping(e.target.checked)} /> Also refund the delivery charge ({formatMoney(sale.data.shippingRefundable)})
                </label>
              )}
              {can('returns.approve') && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={approve} onChange={(e) => setApprove(e.target.checked)} /> Approve now
                </label>
              )}
            </CardContent>
          </Card>
          <Button disabled={create.isPending || chosen.length === 0 || reason.trim().length < 3} onClick={() => (setError(null), create.mutate())}>
            {create.isPending ? 'Saving…' : approve ? 'Create and approve return' : 'Request return'}
          </Button>
        </div>
      )}
    </DocumentShell>
  );
}

function RefundDialog({ ret, open, onOpenChange, onDone }: { ret: ReturnDetail; open: boolean; onOpenChange: (o: boolean) => void; onDone: (r: ReturnDetail) => void }) {
  const methods = usePaymentMethods();
  const [methodId, setMethodId] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per dialog: a double click or a retry cannot refund twice.
  const [key] = useState(() => crypto.randomUUID());
  const refund = useMutation({
    mutationFn: () => api.post<DataEnvelope<ReturnDetail>>(`/returns/${ret.id}/refund`, { paymentMethodId: methodId || undefined, reference }, { headers: { 'Idempotency-Key': key } }),
    onSuccess: (res) => onDone(res.data),
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund {formatMoney(ret.total)}</DialogTitle>
          <DialogDescription>If the customer still owes money on this sale, that is reduced first and only the rest is paid back.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="grid gap-4">
          <Field id="refund-method" label="Pay back by" description={ret.sale.channel === 'ONLINE' ? 'Leave blank to refund the way the order was paid.' : undefined}>
            <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
              <option value="">{ret.sale.channel === 'ONLINE' ? 'Same as the order' : 'Choose…'}</option>
              {methods.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="refund-ref" label="Reference (transfer, card slip…)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={refund.isPending} onClick={() => (setError(null), refund.mutate())}>
            {refund.isPending ? 'Refunding…' : 'Refund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReturnPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'refund' | 'reject' | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const ret = useQuery({
    queryKey: ['returns', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<ReturnDetail>>(`/returns/${id}`, { signal }).then((r) => r.data),
  });
  const update = async (r: ReturnDetail, message: string) => {
    queryClient.setQueryData(['returns', 'detail', r.id], r);
    for (const k of ['returns', 'sales', 'stock', 'customers', 'journals', 'report', 'pos-shift']) void queryClient.invalidateQueries({ queryKey: [k] });
    toast.success(message);
  };
  const act = async (path: string, body: object, message: string) => {
    try {
      await update((await api.post<DataEnvelope<ReturnDetail>>(`/returns/${id}/${path}`, body)).data, message);
      setDialog(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    }
  };
  const r = ret.data;

  return (
    <DocumentShell back={{ to: '/returns', label: 'Returns' }} title={r ? `Return ${r.number}` : 'Return'} isNew={false} query={ret}>
      {r && (
        <div className="space-y-6">
          {r.rejectedReason && <Alert variant="destructive">Rejected: {r.rejectedReason}</Alert>}
          <Card>
            <CardContent className="space-y-4 pt-5">
              <InfoGrid
                items={[
                  ['Status', <StatusBadge key="s" status={r.status === 'COMPLETED' ? 'REFUNDED' : r.status} />],
                  ['Sale', <Link key="sale" to={`/sales/${r.sale.id}`} className="font-mono hover:underline">{r.sale.number}</Link>],
                  ['Customer', r.customer?.name ?? 'Walk-in'],
                  ['Requested', `${formatDateTime(r.requestedAt)} · ${r.requestedBy}`],
                  ...(r.approvedBy ? ([[r.status === 'REJECTED' ? 'Rejected by' : 'Approved', `${formatDateTime(r.approvedAt)} · ${r.approvedBy}`]] as [string, string][]) : []),
                  ...(r.completedAt ? ([['Refunded', `${formatDateTime(r.completedAt)} · ${r.completedBy ?? ''}`]] as [string, string][]) : []),
                ]}
              />
              <p className="text-sm">Reason: {r.reason}</p>
              <div className="flex flex-wrap gap-2">
                {r.status === 'PENDING_APPROVAL' && can('returns.approve') && <Button onClick={() => void act('approve', {}, 'Return approved')}>Approve</Button>}
                {r.status === 'APPROVED' && can('refunds.process') && <Button onClick={() => setDialog('refund')}>Refund {formatMoney(r.total)}</Button>}
                {(r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED') && can('returns.approve') && (
                  <Button variant="outline" onClick={() => setDialog('reject')}>
                    Reject
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Refund</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        {l.description}
                        <span className="block font-mono text-xs text-muted-foreground">{l.sku}</span>
                      </TableCell>
                      <TableCell>
                        {CONDITION_LABELS[l.condition]}
                        {l.restock && <span className="block text-xs text-muted-foreground">Back to stock</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatQty(l.qty)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(l.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-1 text-sm">
                {r.shippingNet !== '0.00' && (
                  <>
                    <dt className="text-muted-foreground">Delivery</dt>
                    <dd className="text-right tabular-nums">{formatMoney(dec(r.shippingNet).plus(r.shippingTax).toFixed(2))}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">VAT included</dt>
                <dd className="text-right tabular-nums">{formatMoney(dec(r.tax).plus(r.shippingTax).toFixed(2))}</dd>
                <dt className="font-medium">Total</dt>
                <dd className="text-right font-semibold tabular-nums">{formatMoney(r.total)}</dd>
                {r.status === 'COMPLETED' && (
                  <>
                    <dt className="text-muted-foreground">Off the customer's account</dt>
                    <dd className="text-right tabular-nums">{formatMoney(r.creditedToAccount)}</dd>
                    <dt className="text-muted-foreground">Paid back{r.refundMethod ? ` (${r.refundMethod.name})` : ''}</dt>
                    <dd className="text-right tabular-nums">{formatMoney(r.paidOut)}</dd>
                  </>
                )}
              </dl>
            </CardContent>
          </Card>
          {dialog === 'refund' && (
            <RefundDialog
              ret={r}
              open
              onOpenChange={(o) => !o && setDialog(null)}
              onDone={(done) => {
                setDialog(null);
                void update(done, `Refunded ${formatMoney(done.paidOut)}`);
              }}
            />
          )}
          <Dialog open={dialog === 'reject'} onOpenChange={(o) => !o && setDialog(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reject {r.number}?</DialogTitle>
                <DialogDescription>Nothing is refunded and the items can be returned again later if needed.</DialogDescription>
              </DialogHeader>
              <Field id="reject-reason" label="Reason">
                <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" disabled={rejectReason.trim().length < 3} onClick={() => void act('reject', { reason: rejectReason }, 'Return rejected')}>
                  Reject
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </DocumentShell>
  );
}
