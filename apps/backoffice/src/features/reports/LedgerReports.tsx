import { Fragment, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { CustomerItemsReport, CustomerLedger, CustomerSummary, DataEnvelope, ItemLedger, ListEnvelope } from '@rhoyards/shared';
import { Button, cn, Field, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { EmptyState } from '../../components/page';
import { StoreFilter } from '../../components/StoreFilter';
import { VariantPicker } from '../../components/VariantPicker';
import { api, qs } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { CsvLink, Num, Shell, useRange, useReport, useStore } from './OperationalReports';

/** The report's subject (a customer or a product) lives in the URL, so other pages can link straight to it. */
function useSubject(key: 'customerId' | 'variantId') {
  const [params, setParams] = useSearchParams();
  const id = params.get(key) ?? '';
  const set = (value: string) => setParams(value ? { [key]: value } : {}, { replace: true });
  return [id, set] as const;
}

const TotalRow = ({ children }: { children: ReactNode }) => <TableRow className="bg-muted/40 hover:bg-muted/40">{children}</TableRow>;

/** "Search a customer" box; once chosen, shows the name with a button to clear it. */
function CustomerFilter({ id, name, onChange, optional }: { id: string; name: string | undefined; onChange: (id: string) => void; optional?: boolean }) {
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 250);
  const results = useQuery({
    queryKey: ['customers', 'search', q],
    queryFn: ({ signal }) => api.get<ListEnvelope<CustomerSummary>>(`/customers${qs({ q, pageSize: 10 })}`, { signal }).then((r) => r.data),
    enabled: q.length >= 2,
  });
  const chosen = useQuery({
    queryKey: ['customers', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<CustomerSummary>>(`/customers/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id) && !name,
  });
  if (id) {
    return (
      <Field id="r-customer" label="Customer" className="w-72">
        <div className="flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm">
          <span className="truncate font-medium">{name ?? chosen.data?.name ?? 'Loading…'}</span>
          <Button variant="ghost" size="icon" className="size-6" aria-label="Choose another customer" onClick={() => onChange('')}>
            <X />
          </Button>
        </div>
      </Field>
    );
  }
  return (
    <div className="relative w-72">
      <Field id="r-customer" label={optional ? 'Customer (all if blank)' : 'Customer'}>
        <Input type="search" placeholder="Search name, phone or code" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </Field>
      {q.length >= 2 && results.data && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md" aria-label="Matching customers">
          {results.data.length === 0 && <li className="p-2 text-sm text-muted-foreground">No customers match.</li>}
          {results.data.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onChange(c.id);
                  setText('');
                }}
              >
                <span className="font-medium">{c.name}</span> <span className="text-xs text-muted-foreground">{[c.code, c.phone].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Items bought per customer ─────────────────────────────────────────────

export function CustomerItemsReportPage() {
  const { from, to, filters } = useRange();
  const { storeParam, storeFilter } = useStore();
  const [customerId, setCustomerId] = useSubject('customerId');
  const params = { from, to, ...storeParam, ...(customerId ? { customerId } : {}) };
  const report = useReport<CustomerItemsReport>('customer-items', params);
  const r = report.data;
  return (
    <Shell
      title="Items per customer"
      description="What each named customer bought, less what they returned, net of VAT and discounts. Walk-in sales have no customer and are left out."
      csv={<CsvLink path="customer-items" params={params} />}
      query={report}
      filters={
        <>
          {filters}
          {storeFilter}
          <CustomerFilter id={customerId} name={r?.customers.find((c) => c.customerId === customerId)?.customer} onChange={setCustomerId} optional />
        </>
      }
    >
      {r &&
        (r.rows.length === 0 ? (
          <EmptyState title="No customer purchases in these dates" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="hidden text-right md:table-cell">Last bought</TableHead>
                <TableHead className="text-right">Net sales</TableHead>
                <TableHead className="hidden text-right md:table-cell">Incl. VAT</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.customers.map((c) => (
                <Fragment key={c.customerId}>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell className="font-semibold">
                      <Link to={`/reports/customer-ledger?customerId=${c.customerId}`} className="hover:underline">
                        {c.customer}
                      </Link>{' '}
                      <span className="font-mono text-xs font-normal text-muted-foreground">{c.customerCode}</span>
                    </TableCell>
                    <Num strong>{formatQty(c.qtySold)}</Num>
                    <TableCell className="hidden md:table-cell" />
                    <Num strong>{formatMoney(c.netSales)}</Num>
                    <TableCell className="hidden text-right font-semibold tabular-nums md:table-cell">{formatMoney(c.total)}</TableCell>
                  </TableRow>
                  {r.rows
                    .filter((row) => row.customerId === c.customerId)
                    .map((row) => (
                      <TableRow key={`${row.customerId}:${row.variantId}`}>
                        <TableCell className="pl-6">
                          {row.product}
                          <span className="block font-mono text-xs text-muted-foreground">{row.sku}</span>
                        </TableCell>
                        <Num>
                          {formatQty(row.qtySold)}
                          {row.qtyReturned !== '0.000' && <span className="block text-xs text-muted-foreground">−{formatQty(row.qtyReturned)} returned</span>}
                        </Num>
                        <TableCell className="hidden text-right md:table-cell">{formatDate(row.lastBought)}</TableCell>
                        <Num>{formatMoney(row.netSales)}</Num>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMoney(row.total)}</TableCell>
                      </TableRow>
                    ))}
                </Fragment>
              ))}
              <TotalRow>
                <TableCell className="font-semibold">Total</TableCell>
                <Num strong>{formatQty(r.totals.qtySold)}</Num>
                <TableCell className="hidden md:table-cell" />
                <Num strong>{formatMoney(r.totals.netSales)}</Num>
                <TableCell className="hidden text-right font-semibold tabular-nums md:table-cell">{formatMoney(r.totals.total)}</TableCell>
              </TotalRow>
            </TableBody>
          </Table>
        ))}
    </Shell>
  );
}

// ── Item ledger ───────────────────────────────────────────────────────────

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: 'Opening stock',
  PURCHASE_RECEIPT: 'Purchase receipt',
  PURCHASE_RETURN: 'Purchase return',
  SALE: 'Sale',
  SALE_RETURN: 'Sale return',
  ADJUSTMENT_IN: 'Adjustment in',
  ADJUSTMENT_OUT: 'Adjustment out',
  WRITE_OFF: 'Write-off',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
};

const SOURCE_PATHS: Record<string, string> = {
  SALE: '/sales',
  SALE_RETURN: '/returns',
  STOCK_ADJUSTMENT: '/inventory/adjustments',
  STOCK_TRANSFER: '/inventory/transfers',
  GOODS_RECEIPT: '/purchasing/receipts',
  PURCHASE_RETURN: '/purchasing/returns',
};

const SourceLink = ({ type, id, label }: { type: string; id: string; label: string }) =>
  SOURCE_PATHS[type] ? (
    <Link to={`${SOURCE_PATHS[type]}/${id}`} className="font-mono text-xs hover:underline">
      {label}
    </Link>
  ) : (
    <span className="font-mono text-xs">{label}</span>
  );

export function ItemLedgerPage() {
  const { from, to, filters } = useRange();
  const [store, setStore] = useState('');
  const [variantId, setVariantId] = useSubject('variantId');
  const params = { from, to, variantId, ...(store ? { locationId: store } : {}) };
  const report = useReport<ItemLedger>('item-ledger', params, Boolean(variantId));
  const r = report.data;
  return (
    <Shell
      title="Item ledger"
      description="Every stock movement of one product, with the running quantity. For all stores, moves between stores are left out: they don't change what the business holds."
      csv={variantId ? <CsvLink path="item-ledger" params={params} /> : null}
      query={report}
      filters={
        <>
          {filters}
          <StoreFilter value={store} onChange={setStore} anyStore />
          {variantId ? (
            <Field id="r-item" label="Product" className="w-80">
              <div className="flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm">
                <span className="truncate font-medium">{r ? `${r.item.product} — ${r.item.variant}` : 'Loading…'}</span>
                <Button variant="ghost" size="icon" className="size-6" aria-label="Choose another product" onClick={() => setVariantId('')}>
                  <X />
                </Button>
              </div>
            </Field>
          ) : (
            <div className="w-80">
              <span className="mb-1.5 block text-sm font-medium">Product</span>
              <VariantPicker onSelect={(v) => setVariantId(v.id)} label="Choose a product" placeholder="Search or scan a product" />
            </div>
          )}
        </>
      }
    >
      {!variantId && <EmptyState title="Choose a product to see its ledger" />}
      {variantId && r && (
        <>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{r.item.sku}</span> · {r.store ? r.store.name : 'All stores'} · average cost now {formatMoney(r.item.avgCost)}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Movement</TableHead>
                <TableHead className="hidden lg:table-cell">Store / lot</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="hidden text-right md:table-cell">Unit cost</TableHead>
                <TableHead className="hidden text-right md:table-cell">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TotalRow>
                <TableCell className="text-xs">{formatDate(r.from)}</TableCell>
                <TableCell className="font-semibold">Opening balance</TableCell>
                <TableCell className="hidden lg:table-cell" />
                <TableCell colSpan={2} />
                <Num strong>{formatQty(r.opening.qty)}</Num>
                <TableCell className="hidden md:table-cell" />
                <TableCell className="hidden text-right font-semibold tabular-nums md:table-cell">{formatMoney(r.opening.value)}</TableCell>
              </TotalRow>
              {r.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDateTime(l.at)}
                    <div className="text-muted-foreground">{l.by}</div>
                  </TableCell>
                  <TableCell>
                    {MOVEMENT_LABELS[l.type] ?? l.type}
                    <div>
                      <SourceLink type={l.sourceType} id={l.sourceId} label={l.reference ?? l.sourceType} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {l.location}
                    {l.lotNumber && <div className="font-mono text-xs text-muted-foreground">Lot {l.lotNumber}</div>}
                  </TableCell>
                  <Num>{l.qtyIn === '0.000' ? '' : formatQty(l.qtyIn)}</Num>
                  <TableCell className="text-right tabular-nums text-destructive">{l.qtyOut === '0.000' ? '' : formatQty(l.qtyOut)}</TableCell>
                  <Num strong>{formatQty(l.balance)}</Num>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMoney(l.unitCost)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMoney(l.value)}</TableCell>
                </TableRow>
              ))}
              {r.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    No movements in these dates
                  </TableCell>
                </TableRow>
              )}
              <TotalRow>
                <TableCell className="text-xs">{formatDate(r.to)}</TableCell>
                <TableCell className="font-semibold">Closing balance</TableCell>
                <TableCell className="hidden lg:table-cell" />
                <Num strong>{formatQty(r.totals.qtyIn)}</Num>
                <Num strong>{formatQty(r.totals.qtyOut)}</Num>
                <Num strong>{formatQty(r.closing.qty)}</Num>
                <TableCell className="hidden md:table-cell" />
                <TableCell className="hidden text-right font-semibold tabular-nums md:table-cell">{formatMoney(r.closing.value)}</TableCell>
              </TotalRow>
            </TableBody>
          </Table>
        </>
      )}
    </Shell>
  );
}

// ── Customer ledger ───────────────────────────────────────────────────────

const LEDGER_PATHS: Record<CustomerLedger['lines'][number]['type'], string> = { SALE: '/sales', RECEIPT: '', RETURN: '/returns' };
const owed = (balance: string) => (balance.startsWith('-') ? `${formatMoney(balance.slice(1))} in credit` : formatMoney(balance));

export function CustomerLedgerPage() {
  const { from, to, filters } = useRange();
  const [customerId, setCustomerId] = useSubject('customerId');
  const params = { from, to, customerId };
  const report = useReport<CustomerLedger>('customer-ledger', params, Boolean(customerId));
  const r = report.data;
  return (
    <Shell
      title="Customer ledger"
      description="All of one customer's sales, payments and returns. The balance is what they owe: a sale paid in full at the till shows but leaves it unchanged."
      csv={customerId ? <CsvLink path="customer-ledger" params={params} /> : null}
      query={report}
      filters={
        <>
          {filters}
          <CustomerFilter id={customerId} name={r?.customer.name} onChange={setCustomerId} />
        </>
      }
    >
      {!customerId && <EmptyState title="Choose a customer to see their ledger" />}
      {customerId && r && (
        <>
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            {[
              ['Bought', r.totals.purchases],
              ['Paid', r.totals.payments],
              ['Returned', r.totals.returns],
              ['Owed at close', null],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border p-3">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{value === null ? owed(r.closingBalance) : formatMoney(value!)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground">
            <Link to={`/customers/${r.customer.id}`} className="hover:underline">
              {r.customer.name}
            </Link>{' '}
            · <span className="font-mono">{r.customer.code}</span>
            {r.customer.phone && ` · ${r.customer.phone}`}
            {r.customer.allowCredit && ` · credit limit ${formatMoney(r.customer.creditLimit)}`}
            {r.totals.refunds !== '0.00' && ` · ${formatMoney(r.totals.refunds)} refunded`}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Document</TableHead>
                <TableHead className="hidden md:table-cell">Details</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TotalRow>
                <TableCell className="text-xs">{formatDate(r.from)}</TableCell>
                <TableCell className="font-semibold">Opening balance</TableCell>
                <TableCell className="hidden md:table-cell" />
                <TableCell colSpan={2} />
                <Num strong>{owed(r.openingBalance)}</Num>
              </TotalRow>
              {r.lines.map((l) => (
                <TableRow key={`${l.type}:${l.id}`}>
                  <TableCell className="whitespace-nowrap text-xs">{formatDate(l.date)}</TableCell>
                  <TableCell>
                    {LEDGER_PATHS[l.type] ? (
                      <Link to={`${LEDGER_PATHS[l.type]}/${l.id}`} className="font-mono text-xs hover:underline">
                        {l.number}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">{l.number}</span>
                    )}
                    <div className="text-xs text-muted-foreground md:hidden">{l.description}</div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {l.description}
                    {l.location && <div className="text-xs text-muted-foreground">{l.location}</div>}
                  </TableCell>
                  <Num>{l.debit === '0.00' ? '' : formatMoney(l.debit)}</Num>
                  <Num>{l.credit === '0.00' ? '' : formatMoney(l.credit)}</Num>
                  <TableCell className={cn('text-right tabular-nums', l.balance.startsWith('-') && 'text-success')}>{owed(l.balance)}</TableCell>
                </TableRow>
              ))}
              {r.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    Nothing in these dates
                  </TableCell>
                </TableRow>
              )}
              <TotalRow>
                <TableCell className="text-xs">{formatDate(r.to)}</TableCell>
                <TableCell className="font-semibold">Closing balance</TableCell>
                <TableCell className="hidden md:table-cell" />
                <TableCell colSpan={2} />
                <Num strong>{owed(r.closingBalance)}</Num>
              </TotalRow>
            </TableBody>
          </Table>
        </>
      )}
    </Shell>
  );
}
