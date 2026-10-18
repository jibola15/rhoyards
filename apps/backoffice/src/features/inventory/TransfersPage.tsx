import { useState } from 'react';
import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { Alert, buttonVariants, Card, CardContent, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDateTime } from '../../lib/format';
import { useLocations } from '../users/api';
import { useTransfers } from './api';

const PAGE_SIZE = 25;

export function TransfersPage() {
  const { can } = useAuth();
  const locations = useLocations();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useTransfers({ status: status || undefined, page, pageSize: PAGE_SIZE });
  const activeLocations = locations.data?.filter((l) => l.isActive).length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock transfers"
        description="Move stock between locations. Lots travel with the stock; value is unchanged."
        actions={
          can('inventory.transfer') &&
          activeLocations > 1 && (
            <Link to="/inventory/transfers/new" className={buttonVariants()}>
              <Plus />
              New transfer
            </Link>
          )
        }
      />
      {locations.data && activeLocations < 2 && (
        <Alert>
          You have one active location. Add a warehouse or second store under Settings → Locations to transfer stock between them.
        </Alert>
      )}
      <Card>
        <CardContent className="space-y-4 pt-5">
          <Select aria-label="Status" className="sm:w-48" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="DISPATCHED">In transit</option>
            <option value="RECEIVED">Received</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
          {list.isError ? (
            <QueryError error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <>
              <Table aria-busy={list.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>From → To</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.isPending && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {list.data?.data.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Link to={`/inventory/transfers/${t.id}`} className="font-mono text-sm font-medium hover:underline">
                          {t.number}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {t.fromLocation.name} → {t.toLocation.name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{t.lineCount}</TableCell>
                      <TableCell>
                        <StatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="hidden text-xs md:table-cell">
                        {formatDateTime(t.createdAt)}
                        <div className="text-muted-foreground">{t.createdBy}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {list.data?.data.length === 0 && <EmptyState title="No transfers" />}
              {list.data && list.data.meta.total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.meta.total} onPageChange={setPage} />}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
