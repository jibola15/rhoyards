import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AuditLogRow, ListEnvelope } from '@rhoyards/shared';
import { Button, Card, CardContent, Field, Input, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { api, qs } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';

const PAGE_SIZE = 50;

/** Start and end of the chosen local calendar days, as the instants the API filters on. */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

function Change({ row }: { row: AuditLogRow }) {
  const show = (label: string, value: unknown) =>
    value === null || value === undefined ? null : (
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
      </div>
    );
  return (
    <div className="space-y-2 py-2">
      <div className="flex flex-col gap-3 lg:flex-row">
        {show('Before', row.before)}
        {show('After', row.after)}
      </div>
      <p className="text-xs text-muted-foreground">
        {row.entityType}
        {row.entityId ? ` ${row.entityId}` : ''} · IP {row.ip ?? '—'} · request {row.requestId ?? '—'}
      </p>
    </div>
  );
}

/** The audit trail: who did what and when, with the before/after record of each change. Read-only. */
export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = {
    action: useDebouncedValue(action.trim()) || undefined,
    entityType: useDebouncedValue(entityType.trim()) || undefined,
    from: dayStart(from),
    to: dayEnd(to),
    page,
    pageSize: PAGE_SIZE,
  };
  const logs = useQuery({
    queryKey: ['audit', q],
    queryFn: ({ signal }) => api.get<ListEnvelope<AuditLogRow>>(`/audit-logs${qs(q)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" description="Every change made in the system, who made it and when. Records cannot be edited or deleted." />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="au-action" label="Action starts with" description="e.g. return., expense.posted, auth.login">
              <Input value={action} onChange={(e) => reset(() => setAction(e.target.value))} />
            </Field>
            <Field id="au-entity" label="Record type" description="e.g. sale_return, journal_entry, user">
              <Input value={entityType} onChange={(e) => reset(() => setEntityType(e.target.value))} />
            </Field>
            <Field id="au-from" label="From">
              <Input type="date" value={from} onChange={(e) => reset(() => setFrom(e.target.value))} />
            </Field>
            <Field id="au-to" label="To">
              <Input type="date" value={to} onChange={(e) => reset(() => setTo(e.target.value))} />
            </Field>
          </div>
          {logs.isError && <QueryError error={logs.error} onRetry={() => void logs.refetch()} />}
          {logs.isPending && <Skeleton className="h-64 w-full" />}
          {logs.data && (
            <>
              <Table aria-busy={logs.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <span className="sr-only">Details</span>
                    </TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead className="hidden md:table-cell">Record</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.data.data.map((row) => (
                    <Fragment key={row.id}>
                      <TableRow>
                        <TableCell>
                          <Button variant="ghost" size="icon" aria-expanded={open === row.id} aria-label={`Details of ${row.action}`} onClick={() => setOpen(open === row.id ? null : row.id)}>
                            {open === row.id ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{formatDateTime(row.createdAt)}</TableCell>
                        <TableCell>{row.actor?.fullName ?? <span className="text-muted-foreground">System or signed out</span>}</TableCell>
                        <TableCell className="font-mono text-xs">{row.action}</TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">{row.entityType}</TableCell>
                      </TableRow>
                      {open === row.id && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={5}>
                            <Change row={row} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
              {logs.data.data.length === 0 && <EmptyState title="No matching records" />}
              {logs.data.meta.total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={logs.data.meta.total} onPageChange={setPage} />}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
