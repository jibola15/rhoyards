import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  SALES_GROUP_LABELS,
  SALES_GROUPS,
  type DataEnvelope,
  type ExpensesReport,
  type PaymentsReport,
  type SalesGroup,
  type SalesReport,
  type StockReport,
} from '@rhoyards/shared';
import { buttonVariants, Card, CardContent, Field, Input, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { EmptyState, PageHeader, QueryError } from '../../components/page';
import { StoreFilter } from '../../components/StoreFilter';
import { StatusBadge } from '../../components/StatusBadge';
import { api, qs } from '../../lib/api';
import { formatMoney, formatQty } from '../../lib/format';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

function useReport<T>(path: string, params: Record<string, string | number>) {
  return useQuery({
    queryKey: ['report', path, params],
    queryFn: ({ signal }) => api.get<DataEnvelope<T>>(`/reports/${path}${qs(params)}`, { signal }).then((r) => r.data),
  });
}

/** CSV is served by the API; the browser downloads it with the staff session cookie. */
const CsvLink = ({ path, params }: { path: string; params: Record<string, string | number> }) => (
  <a href={`/api/v1/reports/${path}${qs({ ...params, format: 'csv' })}`} className={buttonVariants({ variant: 'outline' })} download>
    <Download />
    Download CSV
  </a>
);

function Shell({ title, description, filters, csv, query, children }: { title: string; description: string; filters: ReactNode; csv: ReactNode; query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} actions={csv} />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-end gap-4">{filters}</div>
          {query.isError && query.error && <QueryError error={query.error} onRetry={() => void query.refetch()} />}
          {query.isPending && <Skeleton className="h-64 w-full" />}
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function useRange() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const filters = (
    <>
      <Field id="r-from" label="From" className="w-44">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value || monthStart())} />
      </Field>
      <Field id="r-to" label="To" className="w-44">
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value || today())} />
      </Field>
    </>
  );
  return { from, to, filters };
}

/** One store's figures, or all (the API limits staff assigned to stores to their own). */
function useStore(anyStore = false) {
  const [store, setStore] = useState('');
  return {
    storeParam: (store ? { locationId: store } : {}) as Record<string, string>,
    storeFilter: <StoreFilter value={store} onChange={setStore} anyStore={anyStore} />,
    store,
  };
}

const Num = ({ children, strong }: { children: ReactNode; strong?: boolean }) => <TableCell className={`text-right tabular-nums ${strong ? 'font-semibold' : ''}`}>{children}</TableCell>;

// ── Sales ────────────────────────────────────────────────────────────────

export function SalesReportPage() {
  const { from, to, filters } = useRange();
  const [groupBy, setGroupBy] = useState<SalesGroup>('day');
  const { storeParam, storeFilter } = useStore();
  const params = { from, to, groupBy, ...storeParam };
  const report = useReport<SalesReport>('sales', params);
  const r = report.data;
  return (
    <Shell
      title="Sales report"
      description="Item sales net of VAT and discounts, less returns, with cost and gross profit. Delivery charges are not included."
      csv={<CsvLink path="sales" params={params} />}
      query={report}
      filters={
        <>
          {filters}
          {storeFilter}
          <Field id="r-group" label="By" className="w-44">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as SalesGroup)}>
              {SALES_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {SALES_GROUP_LABELS[g]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
    >
      {r &&
        (r.rows.length === 0 ? (
          <EmptyState title="No sales in these dates" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{SALES_GROUP_LABELS[r.groupBy]}</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Net sales</TableHead>
                <TableHead className="hidden text-right md:table-cell">Cost</TableHead>
                <TableHead className="text-right">Gross profit</TableHead>
                <TableHead className="hidden text-right md:table-cell">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    {row.label}
                    {row.code && <span className="block font-mono text-xs text-muted-foreground">{row.code}</span>}
                  </TableCell>
                  <Num>{row.sales || ''}</Num>
                  <Num>
                    {formatQty(row.qtySold)}
                    {row.qtyReturned !== '0.000' && <span className="block text-xs text-muted-foreground">−{formatQty(row.qtyReturned)} returned</span>}
                  </Num>
                  <Num>{formatMoney(row.netSales)}</Num>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMoney(row.cost)}</TableCell>
                  <Num>{formatMoney(row.grossProfit)}</Num>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{row.margin ? `${row.margin}%` : '—'}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell className="font-semibold">Total</TableCell>
                <Num strong>{r.totals.sales}</Num>
                <Num strong>{formatQty(r.totals.qtySold)}</Num>
                <Num strong>{formatMoney(r.totals.netSales)}</Num>
                <TableCell className="hidden text-right font-semibold tabular-nums md:table-cell">{formatMoney(r.totals.cost)}</TableCell>
                <Num strong>{formatMoney(r.totals.grossProfit)}</Num>
                <TableCell className="hidden text-right font-semibold tabular-nums md:table-cell">{r.totals.margin ? `${r.totals.margin}%` : '—'}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        ))}
    </Shell>
  );
}

// ── Payments ─────────────────────────────────────────────────────────────

export function PaymentsReportPage() {
  const { from, to, filters } = useRange();
  const { storeParam, storeFilter, store } = useStore();
  const params = { from, to, ...storeParam };
  const report = useReport<PaymentsReport>('payments', params);
  const r = report.data;
  return (
    <Shell
      title="Payments by method"
      description={
        store
          ? 'Money taken at this store’s sales, less its refunds. Customers paying their accounts are not counted against a store.'
          : 'Money taken at sales and from customers paying their accounts, less refunds — what each till, terminal and account should show.'
      }
      csv={<CsvLink path="payments" params={params} />}
      query={report}
      filters={
        <>
          {filters}
          {storeFilter}
        </>
      }
    >
      {r &&
        (r.rows.length === 0 ? (
          <EmptyState title="No payments in these dates" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Customer payments</TableHead>
                <TableHead className="text-right">Refunds</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.rows.map((row) => (
                <TableRow key={row.methodId}>
                  <TableCell>{row.method}</TableCell>
                  <Num>{formatMoney(row.sales)}</Num>
                  <Num>{formatMoney(row.receipts)}</Num>
                  <Num>{row.refunds === '0.00' ? '—' : `(${formatMoney(row.refunds)})`}</Num>
                  <Num strong>{formatMoney(row.net)}</Num>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell className="font-semibold">Total</TableCell>
                <Num strong>{formatMoney(r.totals.sales)}</Num>
                <Num strong>{formatMoney(r.totals.receipts)}</Num>
                <Num strong>{r.totals.refunds === '0.00' ? '—' : `(${formatMoney(r.totals.refunds)})`}</Num>
                <Num strong>{formatMoney(r.totals.net)}</Num>
              </TableRow>
            </TableBody>
          </Table>
        ))}
    </Shell>
  );
}

// ── Expenses ─────────────────────────────────────────────────────────────

export function ExpensesReportPage() {
  const { from, to, filters } = useRange();
  const params = { from, to };
  const report = useReport<ExpensesReport>('expenses', params);
  const r = report.data;
  return (
    <Shell title="Expenses by category" description="Posted expenses only." csv={<CsvLink path="expenses" params={params} />} query={report} filters={filters}>
      {r &&
        (r.rows.length === 0 ? (
          <EmptyState title="No posted expenses in these dates" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Expenses</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">VAT</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.rows.map((row) => (
                <TableRow key={row.categoryId}>
                  <TableCell>
                    <Link to={`/expenses?categoryId=${row.categoryId}`} className="hover:underline">
                      {row.category}
                    </Link>
                  </TableCell>
                  <Num>{row.count}</Num>
                  <Num>{formatMoney(row.net)}</Num>
                  <Num>{formatMoney(row.tax)}</Num>
                  <Num strong>{formatMoney(row.total)}</Num>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell className="font-semibold">Total</TableCell>
                <Num strong>{r.totals.count}</Num>
                <Num strong>{formatMoney(r.totals.net)}</Num>
                <Num strong>{formatMoney(r.totals.tax)}</Num>
                <Num strong>{formatMoney(r.totals.total)}</Num>
              </TableRow>
            </TableBody>
          </Table>
        ))}
    </Shell>
  );
}

// ── Stock ────────────────────────────────────────────────────────────────

const STOCK_LABEL = { all: 'All products', low: 'Low (at or below reorder level)', out: 'Out of stock', slow: 'Not sold in the period' } as const;

export function StockReportPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'all') as keyof typeof STOCK_LABEL;
  const [days, setDays] = useState(90);
  const { storeParam, storeFilter } = useStore(true);
  const query = { status, days, ...storeParam };
  const report = useReport<StockReport>('stock', query);
  const r = report.data;
  return (
    <Shell
      title="Stock report"
      description="Stock on hand at cost with the rate of sale. Days of cover = stock ÷ average daily sales over the period. For one store, the reorder level applies to that store."
      csv={<CsvLink path="stock" params={query} />}
      query={report}
      filters={
        <>
          {storeFilter}
          <Field id="r-status" label="Show" className="w-64">
            <Select value={status} onChange={(e) => setParams(e.target.value === 'all' ? {} : { status: e.target.value }, { replace: true })}>
              {Object.entries(STOCK_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="r-days" label="Rate of sale over" className="w-44">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[30, 60, 90, 180, 365].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </Field>
        </>
      }
    >
      {r &&
        (r.rows.length === 0 ? (
          <EmptyState title="No products match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Reorder at</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="hidden text-right md:table-cell">Sold</TableHead>
                <TableHead className="text-right">Days of cover</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.rows.map((row) => (
                <TableRow key={row.variantId}>
                  <TableCell>
                    {row.product} — {row.variant}
                    <span className="block font-mono text-xs text-muted-foreground">{row.sku}</span>
                  </TableCell>
                  <Num>
                    {formatQty(row.onHand)}
                    {row.reserved !== '0.000' && <span className="block text-xs text-muted-foreground">{formatQty(row.reserved)} held online</span>}
                  </Num>
                  <TableCell className="hidden text-right tabular-nums lg:table-cell">{row.reorderLevel === '0.000' ? '—' : formatQty(row.reorderLevel)}</TableCell>
                  <Num>{formatMoney(row.value)}</Num>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatQty(row.soldInPeriod)}</TableCell>
                  <Num>{row.daysOfCover ?? '—'}</Num>
                  <TableCell>
                    <StatusBadge status={`STOCK_${row.status}`} />
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell className="font-semibold">Total</TableCell>
                <Num strong>{formatQty(r.totals.onHand)}</Num>
                <TableCell className="hidden lg:table-cell" />
                <Num strong>{formatMoney(r.totals.value)}</Num>
                <TableCell colSpan={3} />
              </TableRow>
            </TableBody>
          </Table>
        ))}
    </Shell>
  );
}
