import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FULFILMENT_TRANSITIONS, ORDER_STATUS_LABELS, ORDER_STATUSES, type DataEnvelope, type OrderDetail, type OrderStatus, type OrderSummary } from '@rhoyards/shared';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { DocumentList } from '../../components/DocumentList';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { DocumentShell, InfoGrid } from '../purchasing/shared';

const PROVIDER_LABEL = { MANUAL: 'Bank transfer', TEST: 'Card (test)' } as const;
const NEXT_LABEL: Partial<Record<OrderStatus, string>> = { PROCESSING: 'Start processing', PACKED: 'Mark packed', SHIPPED: 'Mark shipped', DELIVERED: 'Mark delivered' };

export function OrdersPage() {
  return (
    <DocumentList<OrderSummary>
      title="Online orders"
      description="Orders from the website. Unpaid orders hold their stock until payment or the hold runs out."
      queryKey="orders"
      path="/orders"
      statuses={ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] }))}
      searchPlaceholder="Search by order number, customer or email"
      columns={[
        {
          header: 'Order',
          cell: (o) => (
            <Link to={`/orders/${o.id}`} className="font-mono font-medium hover:underline">
              {o.number}
            </Link>
          ),
        },
        { header: 'Placed', cell: (o) => formatDateTime(o.placedAt), className: 'hidden md:table-cell' },
        { header: 'Customer', cell: (o) => o.customer.name },
        { header: 'Payment', cell: (o) => (o.provider ? PROVIDER_LABEL[o.provider] : '—'), className: 'hidden lg:table-cell' },
        { header: 'Total', cell: (o) => formatMoney(o.total), className: 'text-right tabular-nums' },
        { header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
      ]}
    />
  );
}

/** A short form in a dialog: one text field plus a confirm button. */
function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  confirmLabel,
  minLength = 0,
  onConfirm,
  destructive,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  minLength?: number;
  onConfirm: (value: string) => Promise<unknown>;
  destructive?: boolean;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => onConfirm(value.trim()),
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive">{error}</Alert>}
        <Field id="prompt-value" label={label}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={mutation.isPending || value.trim().length < minLength} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderView({ order }: { order: OrderDetail }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'verify' | 'cancel' | 'ship' | 'refund' | 'deposit' | null>(null);
  const update = async (o: OrderDetail, message: string) => {
    queryClient.setQueryData(['orders', 'detail', o.id], o);
    await queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
    for (const key of ['stock', 'sales', 'journals', 'report']) void queryClient.invalidateQueries({ queryKey: [key] });
    toast.success(message);
  };
  const post = (path: string, body: object = {}) => api.post<DataEnvelope<OrderDetail>>(`/orders/${order.id}/${path}`, body).then((r) => r.data);
  const move = async (to: OrderStatus, extra: object = {}) => {
    try {
      await update(await post('status', { to, ...extra }), `Order ${ORDER_STATUS_LABELS[to].toLowerCase()}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the order');
    }
  };
  const next = FULFILMENT_TRANSITIONS[order.status]?.filter((s) => (order.shipping.isPickup ? s !== 'SHIPPED' : !(order.status === 'PACKED' && s === 'DELIVERED'))) ?? [];
  const awaitingTransfer = order.status === 'PENDING_PAYMENT' && order.payments.some((p) => p.provider === 'MANUAL' && p.status === 'INITIATED');

  return (
    <div className="space-y-6">
      {order.status === 'ON_HOLD' && (
        <Alert variant="destructive">Paid, but the items sold out before the order could be completed. The payment is held as a customer deposit. When stock is back, complete the order below; otherwise refund the customer.</Alert>
      )}
      {order.status === 'CANCELLED' && order.depositJournalId && <Alert variant="destructive">A payment arrived after this order was cancelled. It is held as a customer deposit to be refunded.</Alert>}
      {order.status === 'PENDING_PAYMENT' && !order.reservedUntil && <Alert>The stock hold has run out. If payment arrives the order completes when the items are still in stock.</Alert>}
      <Card>
        <CardContent className="space-y-4 pt-5">
          <InfoGrid
            items={[
              ['Status', <StatusBadge key="s" status={order.status} />],
              ['Customer', <span key="c">{order.customer.name}<span className="block text-xs text-muted-foreground">{[order.customer.email, order.customer.phone].filter(Boolean).join(' · ')}</span></span>],
              ['Placed', formatDateTime(order.placedAt)],
              ['Stock held until', order.reservedUntil ? formatDateTime(order.reservedUntil) : '—'],
              ['Delivery', order.shipping.name],
              ['Ship to', order.address ? `${order.address.recipient}, ${order.address.line1}${order.address.line2 ? `, ${order.address.line2}` : ''}, ${order.address.city}, ${order.address.state} · ${order.address.phone}` : 'Collection from store'],
              ['Sale', order.sale ? <Link key="sale" to={`/sales/${order.sale.id}`} className="font-mono hover:underline">{order.sale.number}</Link> : '—'],
              ['Tracking', order.trackingReference ?? '—'],
              ...(order.note ? ([['Customer note', order.note]] as [string, string][]) : []),
            ]}
          />
          <div className="flex flex-wrap gap-2">
            {can('orders.manage') &&
              next.map((to) => (
                <Button key={to} onClick={() => (to === 'SHIPPED' ? setDialog('ship') : void move(to))}>
                  {NEXT_LABEL[to]}
                </Button>
              ))}
            {awaitingTransfer && can('payments.verify') && <Button onClick={() => setDialog('verify')}>Confirm bank transfer</Button>}
            {order.status === 'ON_HOLD' && can('orders.manage') && (
              <Button
                onClick={async () => {
                  try {
                    await update(await post('retry-fulfilment'), 'Order completed');
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Could not complete the order');
                  }
                }}
              >
                Complete from deposit
              </Button>
            )}
            {order.status === 'PENDING_PAYMENT' && can('orders.manage') && (
              <Button variant="outline" onClick={() => setDialog('cancel')}>
                Cancel order
              </Button>
            )}
            {['PAID', 'PROCESSING', 'PACKED', 'SHIPPED'].includes(order.status) && can('orders.manage') && can('refunds.process') && (
              <Button variant="outline" onClick={() => setDialog('refund')}>
                Cancel and refund
              </Button>
            )}
            {order.depositJournalId && !order.depositRefundJournalId && can('refunds.process') && (
              <Button variant="outline" onClick={() => setDialog('deposit')}>
                Refund deposit
              </Button>
            )}
            {order.status === 'DELIVERED' && order.sale && can('returns.create') && (
              <Link to={`/returns/new?saleId=${order.sale.id}`} className="inline-flex items-center text-sm underline">
                Return items
              </Link>
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
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((i) => (
                <TableRow key={i.lineNo}>
                  <TableCell>
                    {i.description}
                    <span className="block font-mono text-xs text-muted-foreground">{i.sku}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(i.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(i.unitPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(i.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-1 text-sm">
            <dt className="text-muted-foreground">Items</dt>
            <dd className="text-right tabular-nums">{formatMoney(order.itemsTotal)}</dd>
            <dt className="text-muted-foreground">Delivery</dt>
            <dd className="text-right tabular-nums">{formatMoney(order.shipping.fee)}</dd>
            <dt className="text-muted-foreground">VAT {order.pricesIncludeTax ? '(included)' : ''}</dt>
            <dd className="text-right tabular-nums">{formatMoney(order.taxTotal)}</dd>
            <dt className="font-medium">Total</dt>
            <dd className="text-right font-semibold tabular-nums">{formatMoney(order.total)}</dd>
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {order.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-3 py-2">
                  <div>
                    {PROVIDER_LABEL[p.provider]} · <span className="font-mono">{p.reference}</span>
                    <span className="block text-xs text-muted-foreground">{p.verifiedAt ? `Confirmed ${formatDateTime(p.verifiedAt)} · ${p.verifiedBy ?? ''}` : `Started ${formatDateTime(p.createdAt)}`}</span>
                  </div>
                  <div className="text-right">
                    <span className="tabular-nums">{formatMoney(p.amount)}</span>
                    <span className="block">
                      <StatusBadge status={p.status} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {order.history.map((h, i) => (
                <li key={i}>
                  <span className="font-medium">{ORDER_STATUS_LABELS[h.to]}</span> · {formatDateTime(h.at)}
                  {h.by ? ` · ${h.by}` : ''}
                  {h.note && <span className="block text-muted-foreground">{h.note}</span>}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      <PromptDialog
        open={dialog === 'verify'}
        onOpenChange={(o) => setDialog(o ? 'verify' : null)}
        title={`Confirm payment for ${order.number}?`}
        description={`Check the bank statement shows ${formatMoney(order.total)} with reference ${order.number}. Confirming completes the sale and takes the stock.`}
        label="Bank transaction reference"
        confirmLabel="Confirm payment"
        minLength={3}
        onConfirm={async (reference) => {
          const res = await api.post<DataEnvelope<OrderDetail> & { meta: { result: string } }>(`/orders/${order.id}/verify-payment`, { reference });
          await update(res.data, res.meta.result === 'ON_HOLD' ? 'Payment recorded; order on hold (out of stock)' : 'Payment confirmed');
        }}
      />
      <PromptDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => setDialog(o ? 'cancel' : null)}
        title={`Cancel ${order.number}?`}
        description="The reserved stock goes back on sale. The customer sees the order as cancelled."
        label="Reason"
        confirmLabel="Cancel order"
        minLength={3}
        destructive
        onConfirm={async (reason) => update(await post('cancel', { reason }), 'Order cancelled')}
      />
      <PromptDialog
        open={dialog === 'refund'}
        onOpenChange={(o) => setDialog(o ? 'refund' : null)}
        title={`Cancel and refund ${order.number}?`}
        description={`Everything goes back into stock and ${formatMoney(order.total)} (delivery included) is refunded the way the customer paid.`}
        label="Reason"
        confirmLabel="Refund order"
        minLength={3}
        destructive
        onConfirm={async (reason) => update(await post('refund', { reason, refundShipping: true }), 'Order refunded')}
      />
      <PromptDialog
        open={dialog === 'deposit'}
        onOpenChange={(o) => setDialog(o ? 'deposit' : null)}
        title={`Refund the deposit for ${order.number}?`}
        description={`Pays ${formatMoney(order.total)} back the way the customer paid.${order.status === 'ON_HOLD' ? ' The order is then cancelled.' : ''}`}
        label="Transfer reference (optional)"
        confirmLabel="Refund deposit"
        onConfirm={async (reference) => update(await post('refund-deposit', reference ? { reference } : {}), 'Deposit refunded')}
      />
      {order.returns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Returns</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {order.returns.map((r) => (
                <li key={r.id} className="flex justify-between py-2">
                  <Link to={`/returns/${r.id}`} className="font-mono hover:underline">
                    {r.number}
                  </Link>
                  <span>
                    {formatMoney(r.total)} <StatusBadge status={r.status === 'COMPLETED' ? 'REFUNDED' : r.status} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <PromptDialog
        open={dialog === 'ship'}
        onOpenChange={(o) => setDialog(o ? 'ship' : null)}
        title="Mark as shipped"
        description="Add the courier's tracking reference if there is one; the customer can see it."
        label="Tracking reference (optional)"
        confirmLabel="Mark shipped"
        onConfirm={async (trackingReference) => move('SHIPPED', trackingReference ? { trackingReference } : {})}
      />
    </div>
  );
}

export function OrderPage() {
  const { id } = useParams();
  const order = useQuery({
    queryKey: ['orders', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<OrderDetail>>(`/orders/${id}`, { signal }).then((r) => r.data),
  });
  return (
    <DocumentShell back={{ to: '/orders', label: 'Online orders' }} title={order.data ? `Order ${order.data.number}` : 'Order'} isNew={false} query={order}>
      {order.data && <OrderView order={order.data} />}
    </DocumentShell>
  );
}
