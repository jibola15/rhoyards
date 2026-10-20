import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { DASHBOARD_PERIOD_LABELS, DASHBOARD_PERIODS, type DashboardData, type DashboardPeriod, type DataEnvelope } from '@rhoyards/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { PageHeader, QueryError } from '../../components/page';
import { StoreFilter } from '../../components/StoreFilter';
import { api, qs } from '../../lib/api';
import { formatDate, formatMoney, formatQty } from '../../lib/format';
import { readPreference, writePreference } from '../../lib/storage';

/** ₦0, ₦850, ₦12K, ₦1.2M — axis ticks only; values elsewhere are exact. */
const compact = new Intl.NumberFormat('en-NG', { notation: 'compact', maximumFractionDigits: 1 });
const shortDay = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (iso: string) => shortDay.format(new Date(`${iso}T00:00:00Z`));
const shortMonth = new Intl.DateTimeFormat('en-NG', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const longMonth = new Intl.DateTimeFormat('en-NG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (iso: string) => shortMonth.format(new Date(`${iso}T00:00:00Z`));

const PERIOD_KEY = 'dashboard.period';
const isPeriod = (v: string | null): v is DashboardPeriod => DASHBOARD_PERIODS.includes(v as DashboardPeriod);

/** "1 Oct – 20 Oct 2026", or one date for a single day. */
const rangeLabel = (from: string, to: string) => (from === to ? formatDate(from) : `${dayLabel(from)} – ${formatDate(to)}`);

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

type Point = DashboardData['series']['points'][number];

function SalesTooltip({ active, payload, bucket }: TooltipProps<number, string> & { bucket: 'day' | 'month' }) {
  const p = payload?.[0]?.payload as Point | undefined;
  if (!active || !p) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <p className="font-medium">{bucket === 'month' ? longMonth.format(new Date(`${p.date}T00:00:00Z`)) : formatDate(p.date)}</p>
      <p className="tabular-nums">{formatMoney(p.netSales)} net sales</p>
      <p className="text-muted-foreground">
        {p.sales} sale{p.sales === 1 ? '' : 's'}
      </p>
    </div>
  );
}

/** Net sales per day (or month): one series, so the title names it and there is no legend. */
function SalesChart({ series }: { series: DashboardData['series'] }) {
  const [asTable, setAsTable] = useState(false);
  const data = series.points;
  const monthly = series.bucket === 'month';
  const unit = monthly ? 'month' : 'day';
  const rows = data.map((d) => ({ ...d, value: Number(d.netSales) }));
  const label = (iso: string) => (monthly ? monthLabel(iso) : dayLabel(iso));
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>
          Net sales by {unit}, {rangeLabel(series.from, series.to)}
        </CardTitle>
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
                  <TableHead>{monthly ? 'Month' : 'Day'}</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">Net sales</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...data].reverse().map((d) => (
                  <TableRow key={d.date}>
                    <TableCell>{monthly ? longMonth.format(new Date(`${d.date}T00:00:00Z`)) : formatDate(d.date)}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.sales}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(d.netSales)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div
            className="h-64"
            role="img"
            aria-label={`Net sales per ${unit}, ${rangeLabel(series.from, series.to)}: ${formatMoney(String(rows.reduce((t, r) => t + r.value, 0)))} in total. Use “Show table” for the figures.`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="date" tickFormatter={label} interval="preserveStartEnd" minTickGap={24} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
                <YAxis width={56} tickFormatter={(v: number) => `₦${compact.format(v)}`} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
                <Tooltip content={<SalesTooltip bucket={series.bucket} />} cursor={{ fill: 'var(--muted)', opacity: 0.6 }} />
                <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Best sellers in the period as bars drawn in HTML: five rows read better as a list than as a chart with axes. */
function TopProducts({ data, period }: { data: DashboardData['topProducts']; period: string }) {
  const max = Math.max(...data.map((d) => Number(d.netSales)), 1);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Best sellers, {period.toLowerCase()}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sales in this period.</p>
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
        <CardTitle>Needs attention now</CardTitle>
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
  const [period, setPeriod] = useState<DashboardPeriod>(() => {
    const saved = readPreference(PERIOD_KEY);
    return isPeriod(saved) ? saved : 'this_month';
  });
  const choosePeriod = (p: DashboardPeriod) => {
    setPeriod(p);
    writePreference(PERIOD_KEY, p);
  };
  const dash = useQuery({
    queryKey: ['report', 'dashboard', store, period],
    queryFn: ({ signal }) =>
      api.get<DataEnvelope<DashboardData>>(`/dashboard${qs({ locationId: store || undefined, period })}`, { signal }).then((r) => r.data),
    placeholderData: (prev) => prev,
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
            ? `${d.period.label}: ${rangeLabel(d.period.from, d.period.to)}${d.stores ? ` · ${d.stores.label}` : ''}. ` +
              (d.stores
                ? `Sales, stock and queues are for ${d.stores.ids.length === 1 ? 'this store' : 'these stores'}; balances are for the whole business.`
                : 'Money figures come from the ledger and match the financial reports.')
            : undefined
        }
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <Field id="dashboard-period" label="Period" className="w-44">
              <Select value={period} onChange={(e) => choosePeriod(e.target.value as DashboardPeriod)}>
                {DASHBOARD_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {DASHBOARD_PERIOD_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <StoreFilter value={store} onChange={setStore} />
          </div>
        }
      />
      {dash.isError && <QueryError error={dash.error} onRetry={() => void dash.refetch()} />}
      {dash.isPending && <Skeleton className="h-96 w-full" />}
      {d && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Sales"
              value={formatMoney(d.sales.total)}
              note={`${d.sales.count} sale${d.sales.count === 1 ? '' : 's'} · ${d.sales.onlineOrders} online order${d.sales.onlineOrders === 1 ? '' : 's'} placed`}
              to={`/sales${qs({ from: d.period.from, to: d.period.to })}`}
            />
            <Stat
              label="Net sales"
              value={formatMoney(d.profit.netSales)}
              note="After returns, without VAT"
              {...(finance ? { to: `/reports/profit-and-loss${qs({ from: d.period.from, to: d.period.to })}` } : {})}
            />
            <Stat label="Gross profit" value={formatMoney(d.profit.grossProfit)} note={d.profit.grossMargin ? `${d.profit.grossMargin}% margin` : undefined} />
            {d.profit.netProfit === null ? (
              <Stat label="Net profit" value="—" note="Whole business only: expenses are not split by store" />
            ) : (
              <Stat label="Net profit" value={formatMoney(d.profit.netProfit)} note="After expenses" />
            )}
          </div>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <SalesChart series={d.series} />
            <Attention a={d.attention} />
          </div>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <TopProducts data={d.topProducts} period={d.period.label} />
            <Card>
              <CardHeader>
                <CardTitle>{d.stores ? 'Balances now (whole business)' : 'Balances now'}</CardTitle>
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
