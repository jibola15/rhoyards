import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, buttonVariants, Card, CardContent, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { formatDate, formatQty } from '../../lib/format';
import { useLocations } from '../users/api';
import { useBatches } from './api';

const PAGE_SIZE = 50;

function ExpiryBadge({ days }: { days: number | null }) {
  if (days === null) return <Badge variant="outline">No expiry</Badge>;
  if (days < 0) return <Badge variant="destructive">Expired {Math.abs(days)}d ago</Badge>;
  if (days <= 30) return <Badge variant="warning">{days === 0 ? 'Expires today' : `${days} days left`}</Badge>;
  return <Badge variant="secondary">{days} days left</Badge>;
}

export function ExpiryPage() {
  const { can } = useAuth();
  const locations = useLocations();
  const [within, setWithin] = useState('90');
  const [locationId, setLocationId] = useState('');
  const [page, setPage] = useState(1);
  const batches = useBatches({
    expiringWithinDays: within === 'all' ? undefined : within,
    locationId: locationId || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expiry"
        description="Lots in stock, soonest expiry first. Expired lots are blocked from sale and should be written off."
        actions={
          can('inventory.adjust') && (
            <Link to="/inventory/adjustments/new?reason=EXPIRY" className={buttonVariants({ variant: 'outline' })}>
              Write off expired stock
            </Link>
          )
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select aria-label="Expiring within" className="sm:w-56" value={within} onChange={(e) => (setWithin(e.target.value), setPage(1))}>
              <option value="0">Expired or expiring today</option>
              <option value="30">Expired or within 30 days</option>
              <option value="90">Expired or within 90 days</option>
              <option value="180">Expired or within 180 days</option>
              <option value="all">All lots in stock</option>
            </Select>
            <Select aria-label="Location" className="sm:w-56" value={locationId} onChange={(e) => (setLocationId(e.target.value), setPage(1))}>
              <option value="">All locations</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          {batches.isError ? (
            <QueryError error={batches.error} onRetry={() => void batches.refetch()} />
          ) : (
            <>
              <Table aria-busy={batches.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Lot</TableHead>
                    <TableHead className="hidden md:table-cell">Location</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.isPending && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {batches.data?.data.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell>
                        <div className="font-medium">{b.productName}</div>
                        <div className="text-xs text-muted-foreground">
                          {b.variantName} · <span className="font-mono">{b.sku}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{b.lotNumber}</TableCell>
                      <TableCell className="hidden md:table-cell">{b.location.name}</TableCell>
                      <TableCell>
                        <div>{formatDate(b.expiryDate)}</div>
                        <ExpiryBadge days={b.daysToExpiry} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatQty(b.qtyOnHand)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {batches.data?.data.length === 0 && <EmptyState title="No lots in this range" />}
              {batches.data && batches.data.meta.total > 0 && (
                <Pagination page={page} pageSize={PAGE_SIZE} total={batches.data.meta.total} onPageChange={setPage} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
