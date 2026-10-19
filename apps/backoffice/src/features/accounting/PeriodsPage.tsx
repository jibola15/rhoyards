import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { DataEnvelope, FiscalYearRow, PeriodRow } from '@rhoyards/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
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
import { ConfirmAction } from '../../components/ConfirmAction';
import { PageHeader, QueryError } from '../../components/page';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { useFiscalYears, useRefreshLedger } from './api';

function ReopenDialog({ period, onClose, onDone }: { period: PeriodRow; onClose: () => void; onDone: (years: FiscalYearRow[]) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<DataEnvelope<FiscalYearRow[]>>(`/accounting/periods/${period.id}/reopen`, { reason });
      onDone(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reopen');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen {period.name}?</DialogTitle>
          <DialogDescription>Postings dated in {period.name} will be accepted again until you close it. The reason is kept in the audit log.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive">{error}</Alert>}
        <Field id="reopen-reason" label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>
            {busy ? 'Reopening…' : 'Reopen period'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function YearCard({ year, canManage, onUpdated, onReopen }: { year: FiscalYearRow; canManage: boolean; onUpdated: (years: FiscalYearRow[]) => void; onReopen: (p: PeriodRow) => void }) {
  const refresh = useRefreshLedger();
  const act = async (path: string, success: string) => {
    try {
      const res = await api.post<DataEnvelope<FiscalYearRow[] | { years: FiscalYearRow[] }>>(path);
      onUpdated(Array.isArray(res.data) ? res.data : res.data.years);
      await refresh();
      toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    }
  };
  const nextToClose = year.periods.find((p) => p.status === 'OPEN');
  const lastClosed = [...year.periods].reverse().find((p) => p.status === 'CLOSED');
  const allButLastClosed = year.periods.slice(0, -1).every((p) => p.status === 'CLOSED');

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            {year.name} <StatusBadge status={year.status} />
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {formatDate(year.startDate)} – {formatDate(year.endDate)}
            {year.closingEntry && (
              <>
                {' · closing entry '}
                <Link to={`/accounting/journals/${year.closingEntry.id}`} className="font-mono hover:underline">
                  {year.closingEntry.number}
                </Link>
              </>
            )}
          </p>
        </div>
        {canManage && year.status === 'OPEN' && allButLastClosed && (
          <ConfirmAction
            title={`Close ${year.name} for the year?`}
            description="The year's income and expenses are moved to Retained earnings in one entry dated the last day of the year. The last period and the year are then closed for good."
            confirmLabel="Close the year"
            destructive
            onConfirm={() => act(`/accounting/fiscal-years/${year.id}/close`, `${year.name} closed`)}
          >
            Year-end close
          </ConfirmAction>
        )}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="hidden sm:table-cell">Dates</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Closed</TableHead>
              {canManage && <TableHead className="text-right">Action</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {year.periods.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  {p.name}
                  {p.draftJournals > 0 && (
                    <Badge variant="warning" className="ml-2">
                      {p.draftJournals} draft{p.draftJournals === 1 ? '' : 's'}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {formatDate(p.startDate)} – {formatDate(p.endDate)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={p.status} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">{p.closedAt ? `${formatDateTime(p.closedAt)} · ${p.closedBy ?? ''}` : '—'}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    {year.status === 'OPEN' && p.id === nextToClose?.id && p.id !== year.periods.at(-1)?.id && (
                      <ConfirmAction
                        variant="outline"
                        title={`Close ${p.name}?`}
                        description={`Nothing more can be posted with a date in ${p.name} unless it is reopened.`}
                        confirmLabel="Close period"
                        onConfirm={() => act(`/accounting/periods/${p.id}/close`, `${p.name} closed`)}
                      >
                        Close
                      </ConfirmAction>
                    )}
                    {year.status === 'OPEN' && p.id === lastClosed?.id && (
                      <Button variant="ghost" size="sm" onClick={() => onReopen(p)}>
                        Reopen
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {year.status === 'OPEN' && <p className="mt-3 text-xs text-muted-foreground">Periods close in order once they have ended. The last period of the year is closed by the year-end close.</p>}
      </CardContent>
    </Card>
  );
}

export function PeriodsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const years = useFiscalYears();
  const [reopening, setReopening] = useState<PeriodRow | null>(null);
  const canManage = can('periods.manage');
  const setYears = (data: FiscalYearRow[]) => queryClient.setQueryData(['fiscal-years'], data);
  const addYear = async () => {
    try {
      const res = await api.post<DataEnvelope<FiscalYearRow[]>>('/accounting/fiscal-years');
      setYears(res.data);
      toast.success(`${res.data[0]?.name ?? 'Fiscal year'} added`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the year');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounting periods"
        description="Close each month once its figures are final; closed periods accept no postings. Year-end close moves the profit to retained earnings."
        actions={
          canManage && (
            <Button variant="outline" onClick={() => void addYear()}>
              <Plus />
              Add next year
            </Button>
          )
        }
      />
      {years.isError && <QueryError error={years.error} onRetry={() => void years.refetch()} />}
      {years.isPending && <Skeleton className="h-96 w-full" />}
      {years.data?.map((y) => <YearCard key={y.id} year={y} canManage={canManage} onUpdated={setYears} onReopen={setReopening} />)}
      {reopening && (
        <ReopenDialog
          period={reopening}
          onClose={() => setReopening(null)}
          onDone={(data) => {
            setYears(data);
            toast.success(`${reopening.name} reopened`);
            setReopening(null);
          }}
        />
      )}
    </div>
  );
}
