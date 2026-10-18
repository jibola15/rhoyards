import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Pencil } from 'lucide-react';
import { ADJUSTMENT_REASONS, ADJUSTMENT_REASON_LABELS, type AdjustmentDetail, type AdjustmentReason, type DataEnvelope } from '@rhoyards/shared';
import {
  Button,
  Card,
  CardContent,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader, QueryError } from '../../components/page';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { AdjustmentEditor } from './AdjustmentEditor';
import { STOCK_KEYS, useAdjustment } from './api';

function AdjustmentView({ adjustment }: { adjustment: AdjustmentDetail }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'post' | 'cancel' | null>(null);
  const isDraft = adjustment.status === 'DRAFT';

  const refresh = async (a: AdjustmentDetail) => {
    queryClient.setQueryData(['stock-adjustments', 'detail', a.id], a);
    await queryClient.invalidateQueries({ queryKey: ['stock-adjustments', 'list'] });
    for (const key of STOCK_KEYS) void queryClient.invalidateQueries({ queryKey: key });
  };

  const act = async (action: 'post' | 'cancel') => {
    try {
      const res = await api.post<DataEnvelope<AdjustmentDetail>>(`/stock-adjustments/${adjustment.id}/${action}`);
      await refresh(res.data);
      toast.success(action === 'post' ? `${res.data.number} posted — stock and ledger updated` : `${res.data.number} cancelled`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    }
  };

  if (editing) {
    return (
      <AdjustmentEditor
        existing={adjustment}
        onSaved={(a) => {
          void refresh(a);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={adjustment.status} />
        <span className="text-sm text-muted-foreground">
          {ADJUSTMENT_REASON_LABELS[adjustment.reason]} · {adjustment.location.name}
        </span>
        {isDraft && (
          <div className="ml-auto flex gap-2">
            {can('inventory.adjust') && (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil />
                  Edit
                </Button>
                <Button variant="outline" onClick={() => setConfirm('cancel')}>
                  Cancel draft
                </Button>
              </>
            )}
            {can('inventory.adjust.approve') && <Button onClick={() => setConfirm('post')}>Post adjustment</Button>}
          </div>
        )}
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-5 text-sm sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">Created</div>
            <div>{formatDateTime(adjustment.createdAt)}</div>
            <div className="text-muted-foreground">{adjustment.createdBy}</div>
          </div>
          {adjustment.postedAt && (
            <div>
              <div className="text-muted-foreground">Posted</div>
              <div>{formatDateTime(adjustment.postedAt)}</div>
              <div className="text-muted-foreground">{adjustment.postedBy}</div>
            </div>
          )}
          {adjustment.cancelledAt && (
            <div>
              <div className="text-muted-foreground">Cancelled</div>
              <div>{formatDateTime(adjustment.cancelledAt)}</div>
              <div className="text-muted-foreground">{adjustment.cancelledBy}</div>
            </div>
          )}
          {adjustment.totalValue !== null && (
            <div>
              <div className="text-muted-foreground">Net value change</div>
              <div className="text-lg font-semibold tabular-nums">{formatMoney(adjustment.totalValue)}</div>
            </div>
          )}
          {adjustment.note && (
            <div className="sm:col-span-4">
              <div className="text-muted-foreground">Note</div>
              <div>{adjustment.note}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Lot / expiry</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">{adjustment.status === 'POSTED' ? 'Posted value' : 'Value'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustment.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-muted-foreground">{l.lineNo}</TableCell>
                  <TableCell>
                    <div className="font-medium">{l.variant.productName}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name} · <span className="font-mono">{l.variant.sku}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {l.lotNumber ? <span className="font-mono">{l.lotNumber}</span> : l.variant.isBatchTracked ? 'FEFO' : '—'}
                    {l.expiryDate && <div className="text-muted-foreground">Exp. {formatDate(l.expiryDate)}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.qtyChange)}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.unitCost ? formatMoney(l.unitCost) : 'Average'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.postedValue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm === 'post'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Post ${adjustment.number}?`}
        description="Stock quantities and the general ledger are updated immediately. Posted adjustments cannot be edited — correct mistakes with a new adjustment."
        confirmLabel="Post adjustment"
        onConfirm={() => act('post')}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Cancel ${adjustment.number}?`}
        description="The draft will be kept for the record but can no longer be posted."
        confirmLabel="Cancel draft"
        destructive
        onConfirm={() => act('cancel')}
      />
    </div>
  );
}

export function AdjustmentPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const adjustment = useAdjustment(id);
  const reasonParam = params.get('reason');
  const initialReason = ADJUSTMENT_REASONS.includes(reasonParam as AdjustmentReason) ? (reasonParam as AdjustmentReason) : undefined;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/inventory/adjustments" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Stock adjustments
      </Link>
      <PageHeader title={id ? (adjustment.data ? `Adjustment ${adjustment.data.number}` : 'Adjustment') : 'New stock adjustment'} />
      {!id && <AdjustmentEditor {...(initialReason ? { initialReason } : {})} onCancel={() => navigate('/inventory/adjustments')} />}
      {id && adjustment.isPending && <Skeleton className="h-64 w-full" />}
      {id && adjustment.isError && <QueryError error={adjustment.error} onRetry={() => void adjustment.refetch()} />}
      {adjustment.data && <AdjustmentView key={adjustment.data.id} adjustment={adjustment.data} />}
    </div>
  );
}
