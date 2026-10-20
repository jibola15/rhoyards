import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import type { DashboardData, DataEnvelope } from '@rhoyards/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { PageHeader, QueryError } from '../../components/page';
import { StoreFilter } from '../../components/StoreFilter';
import { api, qs } from '../../lib/api';
import { formatDate, formatMoney, formatQty } from '../../lib/format';

/** ₦0, ₦850, ₦12K, ₦1.2M — axis ticks only; values elsewhere are exact. */
const compact = new Intl.NumberFormat('en-NG', { notation: 'compact', maximumFractionDigits: 1 });
const shortDay = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (iso: string) => shortDay.format(new Date(`${iso}T00:00:00Z`));

function Stat({ label, value, note, to }: { label: string; value: string; note?: ReactNode; to?: string }) {
  const body = (
    <Card className={to ? 'h-full transition-colors hover:bg-muted/40' : 'h-full'}>
      <CardContent className="space-y-1 pt-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
  return to ? (
    <Link to={to} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

function SalesTooltip({ active, payload }: TooltipProps<number, string>) {
  const p = payload?.[0]?.payload as DashboardData['dailySales'][number] | undefined;
  if (!active || !p) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <p className="font-medium">{formatDate(p.date)}</p>
      <p className="tabular-nums">{formatMoney(p.netSales)} net sales</p>
      <p className="text-muted-foreground">
        {p.sales} sale{p.sales === 1 ? '' : 's'}
      </p>
    </div>
  );
}

/** Net sales per day: one series, so the title names it and there is no legend. */
function DailySales({ data }: { data: DashboardData['dailySales'] }) {
  const [asTable, setAsTable] = useState(false);
  const rows = data.map((d) => ({ ...d, value: Number(d.netSales) }));
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>Net sales, last 30 days</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </Button>
      </CardHeader>
      <CardContent>
        {asTable ? (
          <div className="max-h-72 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">Net sales</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...data].reverse().map((d) => (
                  <TableRow key={d.date}>
                    <TableCell>{formatDate(d.date)}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.sales}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(d.netSales)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="h-64" role="img" aria-label={`Net sales per day for the last 30 days, ${formatMoney(String(rows.reduce((t, r) => t + r.value, 0)))} in total. Use “Show table” for the figures.`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="date" tickFormatter={dayLabel} interval={6} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
                <YAxis width={56} tickFormatter={(v: number) => `₦${compact.format(v)}`} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
                <Tooltip content={<SalesTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.6 }} />
                <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Best sellers this month as bars drawn in HTML: five rows read better as a list than as a chart with axes. */
function TopProducts({ data }: { data: DashboardData['topProducts'] }) {
  const max = Math.max(...data.map((d) => Number(d.netSales)), 1);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Best sellers this month</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sales yet this month.</p>
        ) : (
          <ol className="space-y-3">
            {data.map((p) => (
              <li key={p.variantId} className="space-y-1" title={`${p.name}: ${formatMoney(p.netSales)}, ${formatQty(p.qty)} sold`}>
                <div className="flex justify-between gap-3 text-sm">
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 tabular-nums">{formatMoney(p.netSales)}</span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div className="h-2 rounded-full bg-chart-1" style={{ width: `${Math.max(2, (Number(p.netSales) / max) * 100)}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">{formatQty(p.qty)} sold</p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function Attention({ a }: { a: DashboardData['attention'] }) {
  const { can } = useAuth();
  const items: [number, string, string, boolean][] = [
    [a.ordersToFulfil, 'online orders to pack and send', '/orders', can('orders.view')],
    [a.ordersOnHold, 'online orders on hold (paid, out of stock)', '/orders', can('orders.view')],
    [a.ordersAwaitingPayment, 'online orders awaiting payment', '/orders', can('orders.view')],
    [a.returnsToApprove, 'returns to approve or refund', '/returns', can('returns.approve') || can('refunds.process')],
    [a.expensesToApprove, 'expenses to approve', '/expenses', can('expenses.approve')],
    [a.outOfStock, 'products out of stock', '/reports/stock?status=out', can('inventory.view') || can('reports.inventory')],
    [a.lowStock, 'products at or below their reorder level', '/reports/stock?status=low', can('inventory.view') || can('reports.inventory')],
    [a.expiringSoon, 'lots expiring soon', '/inventory/expiry', can('inventory.view')],
  ];
  const shown = items.filter(([n, , , allowed]) => n > 0 && allowed);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting.</p>
        ) : (
          <ul className="divide-y text-sm">
            {shown.map(([n, label, to]) => (
              <li key={label}>
                <Link to={to} className="flex items-center gap-3 py-2 hover:underline">
                  <span className="min-w-8 rounded-md bg-muted px-2 py-0.5 text-center font-semibold tabular-nums">{n}</span>
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { can } = useAuth();
  const [store, setStore] = useState('');
  const dash = useQuery({
    queryKey: ['report', 'dashboard', store],
    queryFn: ({ signal }) => api.get<DataEnvelope<DashboardData>>(`/dashboard${qs({ locationId: store || undefined })}`, { signal }).then((r) => r.data),
    refetchInterval: 60_000,
  });
  const d = dash.data;
  const finance = can('reports.financial');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={
          d
            ? d.stores
              ? `${d.stores.label} · as at ${formatDate(d.asOf)}. Sales, stock and queues are for ${d.stores.ids.length === 1 ? 'this store' : 'these stores'}; balances are for the whole business.`
              : `As at ${formatDate(d.asOf)}. Money figures come from the ledger and match the financial reports.`
            : undefined
        }
        actions={<StoreFilter value={store} onChange={setStore} />}
      />
      {dash.isError && <QueryError error={dash.error} onRetry={() => void dash.refetch()} />}
      {dash.isPending && <Skeleton className="h-96 w-full" />}
      {d && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Sales today" value={formatMoney(d.today.salesTotal)} note={`${d.today.salesCount} sale${d.today.salesCount === 1 ? '' : 's'} · ${d.today.onlineOrders} online order${d.today.onlineOrders === 1 ? '' : 's'} placed`} to="/sales" />
            <Stat label="Net sales this month" value={formatMoney(d.monthToDate.netSales)} note={`Since ${formatDate(d.monthToDate.from)}, after returns, without VAT`} {...(finance ? { to: '/reports/profit-and-loss' } : {})} />
            <Stat label="Gross profit this month" value={formatMoney(d.monthToDate.grossProfit)} note={d.monthToDate.grossMargin ? `${d.monthToDate.grossMargin}% margin` : undefined} />
            {d.monthToDate.netProfit === null ? (
              <Stat label="Net profit this month" value="—" note="Whole business only: expenses are not split by store" />
            ) : (
              <Stat label="Net profit this month" value={formatMoney(d.monthToDate.netProfit)} note="After expenses" />
            )}
          </div>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <DailySales data={d.dailySales} />
            <Attention a={d.attention} />
          </div>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <TopProducts data={d.topProducts} />
            <Card>
              <CardHeader>
                <CardTitle>{d.stores ? 'Balances (whole business)' : 'Balances'}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
                  {d.balances.cashAccounts.map((a) => (
                    <div key={a.id} className="contents">
                      <dt className="text-muted-foreground">{a.name}</dt>
                      <dd className="text-right tabular-nums">{formatMoney(a.balance)}</dd>
                    </div>
                  ))}
                  <dt className="font-medium">Cash and bank</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatMoney(d.balances.cash)}</dd>
                  <dt className="pt-2 text-muted-foreground">Customers owe</dt>
                  <dd className="pt-2 text-right tabular-nums">{formatMoney(d.balances.receivables)}</dd>
                  <dt className="text-muted-foreground">We owe suppliers</dt>
                  <dd className="text-right tabular-nums">{formatMoney(d.balances.payables)}</dd>
                  <dt className="text-muted-foreground">Stock at cost</dt>
                  <dd className="text-right tabular-nums">{formatMoney(d.balances.inventory)}</dd>
                </dl>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
