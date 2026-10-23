import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { InventoryReport, InventoryView } from '@rhoyards/shared';
import { Checkbox, Field, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { EmptyState } from '../../components/page';
import { formatMoney, formatQty } from '../../lib/format';
import { CsvLink, Num, Shell, useReport, useStore } from './OperationalReports';

type Row = InventoryReport['rows'][number];

const qtyOrDash = (q: string) => (q === '0.000' ? '—' : formatQty(q));

const ProductCell = ({ row }: { row: Row }) => (
  <TableCell>
    <Link to={`/reports/item-ledger?variantId=${row.variantId}`} className="hover:underline">
      {row.product} — {row.variant}
    </Link>
    <span className="block font-mono text-xs text-muted-foreground">{row.sku}</span>
  </TableCell>
);

/** Every product with its business-wide total and a column per location. */
function SummaryTable({ report, rows, filtered }: { report: InventoryReport; rows: Row[]; filtered: boolean }) {
  const perStore = report.stores.length > 1;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Total on hand</TableHead>
          <TableHead className="text-right">Total value</TableHead>
          {perStore &&
            report.stores.map((st) => (
              <TableHead key={st.id} className="text-right">
                {st.name}
              </TableHead>
            ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.variantId}>
            <ProductCell row={row} />
            <Num>{formatQty(row.onHand)}</Num>
            <Num>{formatMoney(row.value)}</Num>
            {perStore &&
              row.byStore.map((at, i) => (
                <TableCell key={report.stores[i]!.id} className="text-right tabular-nums" title={at.qty === '0.000' ? undefined : formatMoney(at.value)}>
                  {qtyOrDash(at.qty)}
                </TableCell>
              ))}
          </TableRow>
        ))}
        {!filtered && (
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableCell className="font-semibold">Total</TableCell>
            <Num strong>{formatQty(report.totals.onHand)}</Num>
            <Num strong>{formatMoney(report.totals.value)}</Num>
            {perStore &&
              report.totals.byStore.map((at, i) => (
                <TableCell key={report.stores[i]!.id} className="text-right font-semibold tabular-nums">
                  {formatQty(at.qty)}
                  <span className="block text-xs font-normal text-muted-foreground">{formatMoney(at.value)}</span>
                </TableCell>
              ))}
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** One section per location (A–Z), each listing what is on hand there. */
function ByLocation({ report, rows, filtered, includeZero }: { report: InventoryReport; rows: Row[]; filtered: boolean; includeZero: boolean }) {
  return (
    <div className="space-y-8">
      {report.stores.map((st, i) => {
        const here = rows.filter((row) => includeZero || row.byStore[i]!.qty !== '0.000');
        const total = report.totals.byStore[i]!;
        return (
          <section key={st.id} aria-labelledby={`inv-${st.id}`} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`inv-${st.id}`} className="text-base font-semibold">
                {st.name}
              </h2>
              {!filtered && (
                <p className="text-sm text-muted-foreground">
                  {here.length} {here.length === 1 ? 'product' : 'products'} · {formatQty(total.qty)} on hand · {formatMoney(total.value)}
                </p>
              )}
            </div>
            {here.length === 0 ? (
              <p className="text-sm text-muted-foreground">{filtered ? 'No matching products here.' : 'Nothing in stock here.'}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Average cost</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {here.map((row) => (
                    <TableRow key={row.variantId}>
                      <ProductCell row={row} />
                      <Num>{formatQty(row.byStore[i]!.qty)}</Num>
                      <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMoney(row.avgCost)}</TableCell>
                      <Num>{formatMoney(row.byStore[i]!.value)}</Num>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function InventoryReportPage() {
  const [params, setParams] = useSearchParams();
  const view: InventoryView = params.get('view') === 'by-location' ? 'by-location' : 'summary';
  const [includeZero, setIncludeZero] = useState(false);
  const [search, setSearch] = useState('');
  const { storeParam, storeFilter } = useStore(true);
  const reportParams = { includeZero: String(includeZero), ...storeParam };
  const report = useReport<InventoryReport>('inventory', reportParams);
  const r = report.data;
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (r?.rows ?? []).filter((row) => {
    const text = `${row.product} ${row.variant} ${row.sku}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const filtered = words.length > 0;
  return (
    <Shell
      title="Inventory report"
      description="What is on hand across the business and at each location, with products and locations in alphabetical order. Values are at average cost. Choose a product to see its ledger."
      csv={<CsvLink path="inventory" params={{ ...reportParams, view }} />}
      query={report}
      filters={
        <>
          {storeFilter}
          <Field id="r-view" label="Show" className="w-60">
            <Select value={view} onChange={(e) => setParams(e.target.value === 'summary' ? {} : { view: e.target.value }, { replace: true })}>
              <option value="summary">All locations, side by side</option>
              <option value="by-location">Each location separately</option>
            </Select>
          </Field>
          <Field id="r-search" label="Find a product" className="w-64">
            <Input type="search" placeholder="Name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <label className="flex h-9 items-center gap-2 text-sm">
            <Checkbox checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} /> Include products with no stock
          </label>
        </>
      }
    >
      {r &&
        (rows.length === 0 ? (
          <EmptyState title={r.rows.length === 0 ? 'Nothing in stock' : 'No products match'} />
        ) : view === 'summary' ? (
          <SummaryTable report={r} rows={rows} filtered={filtered} />
        ) : (
          <ByLocation report={r} rows={rows} filtered={filtered} includeZero={includeZero} />
        ))}
    </Shell>
  );
}
