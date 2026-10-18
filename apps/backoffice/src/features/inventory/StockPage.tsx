import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
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
import { formatMoney, formatQty } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useLocations } from '../users/api';
import { useStock, useValuation } from './api';

const PAGE_SIZE = 50;

function ValuationCard() {
  const valuation = useValuation();
  if (!valuation.data) return null;
  const v = valuation.data;
  const balanced = v.difference === '0.00';
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          Inventory value
          {balanced ? (
            <Badge variant="success">
              <CheckCircle2 className="size-3" aria-hidden="true" /> Reconciled with ledger
            </Badge>
          ) : (
            <Badge variant="destructive">
              <AlertTriangle className="size-3" aria-hidden="true" /> Differs from ledger
            </Badge>
          )}
        </CardTitle>
        <CardDescription>Moving weighted-average cost, company-wide.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Stock ledger value</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatMoney(v.stockLedgerValue)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Inventory account (GL)</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatMoney(v.glInventoryBalance)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Products in stock</dt>
            <dd className="text-lg font-semibold tabular-nums">{v.variantsWithStock}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">In transit</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatQty(v.inTransitQty)}</dd>
          </div>
        </dl>
        {!balanced && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            The stock ledger and the Inventory account differ by {formatMoney(v.difference)}. Ask your accountant to investigate.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function StockPage() {
  const locations = useLocations();
  const [search, setSearch] = useState('');
  const [locationId, setLocationId] = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim());
  const stock = useStock({ q, locationId: locationId || undefined, lowStock: lowStock ? 'true' : undefined, page, pageSize: PAGE_SIZE });

  return (
    <div className="space-y-6">
      <PageHeader title="Stock levels" description="On hand, reserved for online orders, and available to sell." />
      <ValuationCard />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                aria-label="Search stock"
                placeholder="Product, SKU or barcode"
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              aria-label="Location"
              className="md:w-56"
              value={locationId}
              onChange={(e) => {
                setLocationId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All locations</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={lowStock}
                onChange={(e) => {
                  setLowStock(e.target.checked);
                  setPage(1);
                }}
              />
              Low stock only
            </label>
          </div>
          {stock.isError ? (
            <QueryError error={stock.error} onRetry={() => void stock.refetch()} />
          ) : (
            <>
              <Table aria-busy={stock.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Reserved</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Reorder at</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Avg cost</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stock.isPending && (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {stock.data?.data.map((r) => (
                    <TableRow key={r.variantId}>
                      <TableCell>
                        <Link to={`/catalog/products/${r.productId}`} className="font-medium hover:underline">
                          {r.productName}
                        </Link>{' '}
                        <span className="text-muted-foreground">— {r.variantName}</span>
                        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                          {r.sku}
                          {r.isLowStock && <Badge variant="warning">Low stock</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <Link to={`/inventory/movements?variantId=${r.variantId}`} className="hover:underline">
                          {formatQty(r.qtyOnHand)} <span className="text-xs text-muted-foreground">{r.unitCode}</span>
                        </Link>
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums md:table-cell">{formatQty(r.qtyReserved)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatQty(r.qtyAvailable)}</TableCell>
                      <TableCell className="hidden text-right tabular-nums md:table-cell">{formatQty(r.reorderLevel)}</TableCell>
                      <TableCell className="hidden text-right tabular-nums lg:table-cell">{formatMoney(r.avgCost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(r.stockValue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {stock.data?.data.length === 0 && <EmptyState title={lowStock ? 'Nothing is low on stock' : 'No products found'} />}
              {stock.data && stock.data.meta.total > 0 && (
                <Pagination page={page} pageSize={PAGE_SIZE} total={stock.data.meta.total} onPageChange={setPage} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
