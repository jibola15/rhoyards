import { Link, useParams, useSearchParams } from 'react-router';
import { Printer, RotateCcw } from 'lucide-react';
import type { SaleSummary } from '@rhoyards/shared';
import { Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { DocumentList } from '../../components/DocumentList';
import { PageHeader, QueryError } from '../../components/page';
import { formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { useSale } from './api';

export function SalesPage() {
  const [params] = useSearchParams();
  const shiftId = params.get('shiftId') ?? undefined;
  const customerId = params.get('customerId') ?? undefined;
  return (
    <DocumentList<SaleSummary>
      title="Sales"
      description={shiftId ? 'Sales in the selected shift.' : customerId ? "The selected customer's sales." : 'Completed sales. Cashiers see the sales they rang up.'}
      queryKey="sales"
      path="/sales"
      params={{ shiftId, customerId }}
      searchPlaceholder="Search by receipt number or customer"
      columns={[
        { header: 'Receipt', cell: (s) => <Link to={`/sales/${s.id}`} className="font-medium hover:underline">{s.number}</Link> },
        { header: 'Date', cell: (s) => formatDateTime(s.completedAt) },
        { header: 'Till', cell: (s) => s.register?.name ?? s.location.name, className: 'hidden md:table-cell' },
        { header: 'Cashier', cell: (s) => s.cashier, className: 'hidden md:table-cell' },
        { header: 'Customer', cell: (s) => s.customer?.name ?? 'Walk-in' },
        { header: 'Total', cell: (s) => formatMoney(s.total), className: 'text-right' },
        { header: 'Owed', cell: (s) => (Number(s.balanceDue) > 0 ? formatMoney(s.balanceDue) : '—'), className: 'text-right' },
      ]}
    />
  );
}

export function SalePage() {
  const { id } = useParams();
  const { can } = useAuth();
  const sale = useSale(id);
  if (sale.isError) return <QueryError error={sale.error} onRetry={() => void sale.refetch()} />;
  if (sale.isPending) return <Skeleton className="h-96 w-full" />;
  const s = sale.data;
  const row = (label: string, value: string, strong = false) => (
    <>
      <dt className={strong ? 'font-semibold' : 'text-muted-foreground'}>{label}</dt>
      <dd className={strong ? 'text-right font-semibold tabular-nums' : 'text-right tabular-nums'}>{value}</dd>
    </>
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Sale ${s.number ?? '(parked)'}`}
        description={`${formatDateTime(s.completedAt ?? s.createdAt)} · ${s.register?.name ?? s.location.name} · ${s.cashier}${s.shift ? ` · shift ${s.shift.number}` : ''}`}
        actions={
          s.status === 'COMPLETED' && (
            <>
              {can('returns.create') && (
                <Link to={`/returns/new?saleId=${s.id}`} className={buttonVariants({ variant: 'outline' })}>
                  <RotateCcw />
                  Return items
                </Link>
              )}
              <Link to={`/sales/${s.id}/receipt`} className={buttonVariants({ variant: 'outline' })}>
                <Printer />
                Receipt
              </Link>
            </>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardContent className="pt-5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <div className="font-medium">{i.description}</div>
                      <div className="font-mono text-xs text-muted-foreground">{i.sku}</div>
                      {i.unitPrice !== i.listPrice && <Badge variant="outline">List price {formatMoney(i.listPrice)}</Badge>}
                      {Number(i.qtyReturned) > 0 && <Badge variant="secondary">{formatQty(i.qtyReturned)} returned</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{formatQty(i.qty)}</TableCell>
                    <TableCell className="text-right">{formatMoney(i.unitPrice)}</TableCell>
                    <TableCell className="text-right">{Number(i.discountAmount) > 0 ? formatMoney(i.discountAmount) : '—'}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(i.taxAmount)} <span className="text-xs text-muted-foreground">({formatQty(i.taxRate)}%)</span>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatMoney(i.lineTotal)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Totals</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-y-1 text-sm">
                {row('Customer', s.customer?.name ?? 'Walk-in')}
                {row('Prices', s.pricesIncludeTax ? 'VAT inclusive' : 'VAT exclusive')}
                {Number(s.discountTotal) > 0 && row('Discounts', formatMoney(s.discountTotal))}
                {s.discountApprovedBy && row('Approved by', s.discountApprovedBy)}
                {row('Net of VAT', formatMoney(s.subtotal))}
                {row('VAT', formatMoney(s.taxTotal))}
                {row('Total', formatMoney(s.total), true)}
                {row('Cost of goods', formatMoney(s.costTotal))}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Payments</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-y-1 text-sm">
                {s.payments.map((p) => row(`${p.method.name}${p.reference ? ` (${p.reference})` : ''}`, formatMoney(p.amount)))}
                {Number(s.changeGiven) > 0 && row('Change given', formatMoney(s.changeGiven))}
                {row('Owed on account', formatMoney(s.balanceDue), Number(s.balanceDue) > 0)}
              </dl>
              {s.note && <p className="mt-3 text-sm text-muted-foreground">Note: {s.note}</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
