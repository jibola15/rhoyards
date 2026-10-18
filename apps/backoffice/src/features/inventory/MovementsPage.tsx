import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Search, X } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  cn,
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
} from '@rhoyards/ui';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useLocations } from '../users/api';
import { useMovements } from './api';

const PAGE_SIZE = 50;

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

function sourceLink(sourceType: string, sourceId: string) {
  if (sourceType === 'STOCK_ADJUSTMENT') return `/inventory/adjustments/${sourceId}`;
  if (sourceType === 'STOCK_TRANSFER') return `/inventory/transfers/${sourceId}`;
  return null;
}

export function MovementsPage() {
  const [params, setParams] = useSearchParams();
  const variantId = params.get('variantId') ?? undefined;
  const locations = useLocations();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [locationId, setLocationId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim());
  const movements = useMovements({
    q,
    variantId,
    type: type || undefined,
    locationId: locationId || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const resetPage = () => setPage(1);
  const first = movements.data?.data[0];

  return (
    <div className="space-y-6">
      <PageHeader title="Stock movements" description="The stock ledger: every change in quantity, with its cost and source document. Entries are never edited." />
      <Card>
        <CardContent className="space-y-4 pt-5">
          {variantId && (
            <div className="flex items-center gap-2 text-sm">
              <span>
                Showing one product{first ? `: ${first.productName} — ${first.variantName} (${first.sku})` : ''}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setParams({})}>
                <X />
                Show all
              </Button>
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-5">
            {!variantId && (
              <div className="relative md:col-span-2">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  type="search"
                  aria-label="Search by product or SKU"
                  placeholder="Product or SKU"
                  className="pl-8"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    resetPage();
                  }}
                />
              </div>
            )}
            <Select aria-label="Movement type" value={type} onChange={(e) => (setType(e.target.value), resetPage())}>
              <option value="">All types</option>
              {Object.entries(MOVEMENT_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
            <Select aria-label="Location" value={locationId} onChange={(e) => (setLocationId(e.target.value), resetPage())}>
              <option value="">All locations</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <div className="flex gap-2">
              <Field id="mv-from" label="From" className="flex-1">
                <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), resetPage())} />
              </Field>
              <Field id="mv-to" label="To" className="flex-1">
                <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), resetPage())} />
              </Field>
            </div>
          </div>
          {movements.isError ? (
            <QueryError error={movements.error} onRetry={() => void movements.refetch()} />
          ) : (
            <>
              <Table aria-busy={movements.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="hidden lg:table-cell">Location / lot</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Unit cost</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Balance</TableHead>
                    <TableHead>Reference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.isPending && (
                    <TableRow>
                      <TableCell colSpan={9}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {movements.data?.data.map((m) => {
                    const href = sourceLink(m.sourceType, m.sourceId);
                    const negative = m.qtyChange.startsWith('-');
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDateTime(m.createdAt)}
                          <div className="text-muted-foreground">{m.createdBy}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{MOVEMENT_LABELS[m.type] ?? m.type}</TableCell>
                        <TableCell>
                          <div className="font-medium">{m.productName}</div>
                          <div className="text-xs text-muted-foreground">
                            {m.variantName} · <span className="font-mono">{m.sku}</span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {m.location.name}
                          {m.lotNumber && <div className="font-mono text-xs text-muted-foreground">Lot {m.lotNumber}</div>}
                        </TableCell>
                        <TableCell className={cn('text-right font-medium tabular-nums', negative ? 'text-destructive' : 'text-success')}>
                          {negative ? '' : '+'}
                          {formatQty(m.qtyChange)}
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMoney(m.unitCost)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(m.totalCost)}</TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">{formatQty(m.qtyAfter)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {href ? (
                            <Link to={href} className="font-mono text-xs hover:underline">
                              {m.reference ?? 'View'}
                            </Link>
                          ) : (
                            <span className="font-mono text-xs">{m.reference ?? m.sourceType}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {movements.data?.data.length === 0 && <EmptyState title="No stock movements match these filters" />}
              {movements.data && movements.data.meta.total > 0 && (
                <Pagination page={page} pageSize={PAGE_SIZE} total={movements.data.meta.total} onPageChange={setPage} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
