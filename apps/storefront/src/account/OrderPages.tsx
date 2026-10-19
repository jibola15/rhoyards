import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, ORDER_STATUS_LABELS, type DataEnvelope, type StoreOrder } from '@rhoyards/shared';
import { Alert, Badge, Button, buttonVariants, Card, CardContent, CardHeader, CardTitle, Skeleton, toast } from '@rhoyards/ui';
import { api, formatDateTime, formatMoney, formatQty } from '../lib/api';
import { NotFoundPage } from '../pages/NotFoundPage';
import { useCustomer } from './CustomerProvider';

function RequireCustomer({ children, next }: { children: React.ReactNode; next: string }) {
  const { customer, loading } = useCustomer();
  if (loading) return <Skeleton className="mx-auto my-8 h-64 max-w-3xl" />;
  if (!customer) return <Navigate to={`/account/login?next=${encodeURIComponent(next)}`} replace />;
  return children;
}

const badge = (s: StoreOrder['status']) => (
  <Badge variant={s === 'CANCELLED' || s === 'ON_HOLD' ? 'secondary' : s === 'PENDING_PAYMENT' ? 'warning' : 'success'}>{ORDER_STATUS_LABELS[s]}</Badge>
);

export function MyOrdersPage() {
  return (
    <RequireCustomer next="/account/orders">
      <MyOrders />
    </RequireCustomer>
  );
}

function MyOrders() {
  const orders = useQuery({
    queryKey: ['store', 'orders'],
    queryFn: ({ signal }) => api.get<DataEnvelope<StoreOrder[]>>('/orders', { signal }).then((r) => r.data),
  });
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">My orders</h1>
      {orders.isPending && <Skeleton className="h-40 w-full" />}
      {orders.isError && <Alert variant="destructive">{orders.error.message}</Alert>}
      {orders.data?.length === 0 && (
        <p className="text-muted-foreground">
          You have no orders yet. <Link to="/shop" className="underline">Start shopping</Link>
        </p>
      )}
      <ul className="divide-y rounded-lg border">
        {orders.data?.map((o) => (
          <li key={o.id}>
            <Link to={`/account/orders/${o.number}`} className="flex items-center justify-between gap-3 p-4 hover:bg-muted/50">
              <div>
                <span className="font-mono font-medium">{o.number}</span>
                <span className="block text-sm text-muted-foreground">{formatDateTime(o.placedAt)}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular-nums">{formatMoney(o.total)}</span>
                {badge(o.status)}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MyOrderPage() {
  const { number = '' } = useParams();
  return (
    <RequireCustomer next={`/account/orders/${number}`}>
      <MyOrder number={number} />
    </RequireCustomer>
  );
}

function MyOrder({ number }: { number: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const order = useQuery({
    queryKey: ['store', 'orders', number],
    queryFn: ({ signal }) => api.get<DataEnvelope<StoreOrder>>(`/orders/${number}`, { signal }).then((r) => r.data),
    // While a card payment is being confirmed by the gateway, check back for the result.
    refetchInterval: (q) => (q.state.data?.status === 'PENDING_PAYMENT' && q.state.data.payment?.provider === 'TEST' ? 5000 : false),
  });
  const cancel = useMutation({
    mutationFn: () => api.post<DataEnvelope<StoreOrder>>(`/orders/${number}/cancel`).then((r) => r.data),
    onSuccess: (o) => {
      queryClient.setQueryData(['store', 'orders', number], o);
      void queryClient.invalidateQueries({ queryKey: ['store', 'orders'], exact: true });
      toast.success('Order cancelled');
    },
    onError: (e) => toast.error(e.message),
  });
  const retry = useMutation({
    mutationFn: () => api.post<DataEnvelope<StoreOrder>>(`/orders/${number}/pay`).then((r) => r.data),
    onSuccess: (o) => {
      queryClient.setQueryData(['store', 'orders', number], o);
      if (o.payment?.redirectUrl) navigate(o.payment.redirectUrl);
    },
    onError: (e) => toast.error(e.message),
  });
  if (order.isError) return order.error instanceof ApiError && order.error.status === 404 ? <NotFoundPage /> : <Alert variant="destructive">{order.error.message}</Alert>;
  if (!order.data) return <Skeleton className="mx-auto my-8 h-96 max-w-3xl" />;
  const o = order.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Order <span className="font-mono">{o.number}</span>
          </h1>
          <p className="text-sm text-muted-foreground">Placed {formatDateTime(o.placedAt)}</p>
        </div>
        {badge(o.status)}
      </div>

      {o.status === 'PENDING_PAYMENT' && o.payment && (
        <Card>
          <CardHeader>
            <CardTitle>Complete your payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {o.payment.instructions && <p className="whitespace-pre-line">{o.payment.instructions}</p>}
            {o.payment.status === 'FAILED' && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-destructive">Your last payment was declined.</span>
                <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
                  Try paying again
                </Button>
              </div>
            )}
            {o.payment.redirectUrl && (
              <Link to={o.payment.redirectUrl} className={buttonVariants()}>
                Pay {formatMoney(o.total)} now
              </Link>
            )}
            {o.reservedUntil ? (
              <p className="text-muted-foreground">Your items are held until {formatDateTime(o.reservedUntil)}.</p>
            ) : (
              <p className="text-muted-foreground">The hold on your items has ended. If you still pay, we will confirm the order if they are in stock.</p>
            )}
          </CardContent>
        </Card>
      )}
      {o.status === 'ON_HOLD' && <Alert>We received your payment, but an item sold out before we could confirm your order. We will contact you shortly.</Alert>}
      {o.trackingReference && <Alert>Tracking reference: {o.trackingReference}</Alert>}

      <Card>
        <CardContent className="pt-5">
          <ul className="divide-y text-sm">
            {o.items.map((i) => (
              <li key={i.lineNo} className="flex justify-between gap-3 py-2">
                <span>
                  {i.description} × {formatQty(i.qty)}
                </span>
                <span className="tabular-nums">{formatMoney(i.total)}</span>
              </li>
            ))}
          </ul>
          <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-1 text-sm">
            <dt className="text-muted-foreground">Items</dt>
            <dd className="text-right tabular-nums">{formatMoney(o.itemsTotal)}</dd>
            <dt className="text-muted-foreground">{o.shipping.name}</dt>
            <dd className="text-right tabular-nums">{formatMoney(o.shipping.fee)}</dd>
            <dt className="text-muted-foreground">VAT {o.pricesIncludeTax ? '(included)' : ''}</dt>
            <dd className="text-right tabular-nums">{formatMoney(o.taxTotal)}</dd>
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold tabular-nums">{formatMoney(o.total)}</dd>
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{o.address ? 'Delivering to' : 'Collection'}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {o.address ? (
              <address className="not-italic">
                {o.address.recipient}
                <br />
                {o.address.line1}
                {o.address.line2 && (
                  <>
                    <br />
                    {o.address.line2}
                  </>
                )}
                <br />
                {o.address.city}, {o.address.state}
                <br />
                {o.address.phone}
              </address>
            ) : (
              <p>Collect from the store once we tell you the order is ready.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-1 text-sm">
              {o.history
                .filter((h, i, all) => i === 0 || h.to !== all[i - 1]!.to)
                .map((h, i) => (
                  <li key={i}>
                    <span className="font-medium">{ORDER_STATUS_LABELS[h.to]}</span> <span className="text-muted-foreground">· {formatDateTime(h.at)}</span>
                  </li>
                ))}
            </ol>
          </CardContent>
        </Card>
      </div>
      {o.canCancel && (
        <Button variant="outline" disabled={cancel.isPending} onClick={() => window.confirm('Cancel this order?') && cancel.mutate()}>
          Cancel order
        </Button>
      )}
    </div>
  );
}
