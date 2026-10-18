import { useState } from 'react';
import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { ADJUSTMENT_REASON_LABELS } from '@rhoyards/shared';
import { buttonVariants, Card, CardContent, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAdjustments } from './api';

const PAGE_SIZE = 25;

export function AdjustmentsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useAdjustments({ status: status || undefined, page, pageSize: PAGE_SIZE });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock adjustments"
        description="Opening stock, count corrections, damage, expiry and losses. Posting moves stock and records the accounting entry."
        actions={
          can('inventory.adjust') && (
            <Link to="/inventory/adjustments/new" className={buttonVariants()}>
              <Plus />
              New adjustment
            </Link>
          )
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <Select aria-label="Status" className="sm:w-48" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="POSTED">Posted</option>
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
                    <TableHead>Reason</TableHead>
                    <TableHead className="hidden md:table-cell">Location</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.isPending && (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {list.data?.data.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Link to={`/inventory/adjustments/${a.id}`} className="font-mono text-sm font-medium hover:underline">
                          {a.number}
                        </Link>
                      </TableCell>
                      <TableCell>{ADJUSTMENT_REASON_LABELS[a.reason]}</TableCell>
                      <TableCell className="hidden md:table-cell">{a.location.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.lineCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(a.totalValue)}</TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell className="hidden text-xs lg:table-cell">
                        {formatDateTime(a.createdAt)}
                        <div className="text-muted-foreground">{a.createdBy}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {list.data?.data.length === 0 && <EmptyState title="No adjustments" />}
              {list.data && list.data.meta.total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.meta.total} onPageChange={setPage} />}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
