import { Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { DataEnvelope, StoreOrder } from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardHeader, Skeleton } from '@rhoyards/ui';
import { useCustomer } from '../account/CustomerProvider';
import { api, formatMoney } from '../lib/api';

interface TestPayment {
  reference: string;
  orderNumber: string;
  amount: string;
  status: 'INITIATED' | 'SUCCEEDED' | 'FAILED';
}

/**
 * Stand-in for a card gateway's hosted page (development and testing only). Paying here makes the API send itself a
 * signed webhook, exactly as a real gateway would; the order is marked paid by that webhook, not by this page.
 */
export function TestPayPage() {
  const { reference = '' } = useParams();
  const { customer, loading } = useCustomer();
  const navigate = useNavigate();
  const payment = useQuery({
    queryKey: ['store', 'test-payment', reference],
    queryFn: ({ signal }) => api.get<DataEnvelope<TestPayment>>(`/test-gateway/${reference}`, { signal }).then((r) => r.data),
    enabled: Boolean(customer),
  });
  const pay = useMutation({
    mutationFn: (outcome: 'succeeded' | 'failed') => api.post<DataEnvelope<StoreOrder>>(`/test-gateway/${reference}`, { outcome }).then((r) => r.data),
    onSuccess: (order) => navigate(`/account/orders/${order.number}`, { replace: true }),
  });
  if (loading) return <Skeleton className="mx-auto my-8 h-64 max-w-md" />;
  if (!customer) return <Navigate to={`/account/login?next=/pay/test/${reference}`} replace />;

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <Card>
        <CardHeader>
          <h1 className="text-lg font-semibold">Test card payment</h1>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>This is a sandbox gateway for trying the store. No card is charged.</Alert>
          {payment.isPending && <Skeleton className="h-16 w-full" />}
          {payment.isError && <Alert variant="destructive">{payment.error.message}</Alert>}
          {pay.isError && <Alert variant="destructive">{pay.error.message}</Alert>}
          {payment.data && (
            <>
              <p>
                Order <span className="font-mono">{payment.data.orderNumber}</span>: <strong>{formatMoney(payment.data.amount)}</strong>
              </p>
              {payment.data.status === 'INITIATED' ? (
                <div className="flex gap-2">
                  <Button disabled={pay.isPending} onClick={() => pay.mutate('succeeded')}>
                    Pay {formatMoney(payment.data.amount)}
                  </Button>
                  <Button variant="outline" disabled={pay.isPending} onClick={() => pay.mutate('failed')}>
                    Decline
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">This payment has already been {payment.data.status === 'SUCCEEDED' ? 'made' : 'declined'}.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
