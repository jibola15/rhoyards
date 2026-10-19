import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DataEnvelope, GeneralLedger } from '@rhoyards/shared';
import { Card, CardContent, Field, Input, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { api, qs } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/format';
import { sourceLabel, today, useAccounts, yearStart } from './api';

const PAGE_SIZE = 100;

export function LedgerPage() {
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const accountId = params.get('accountId') ?? '';
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [page, setPage] = useState(1);
  const ledger = useQuery<GeneralLedger>({
    queryKey: ['ledger', accountId, from, to, page],
    queryFn: ({ signal }) =>
      api.get<DataEnvelope<GeneralLedger>>(`/accounting/ledger${qs({ accountId, from, to, page, pageSize: PAGE_SIZE })}`, { signal }).then((r) => r.data),
    enabled: Boolean(accountId) && Boolean(from) && Boolean(to),
    placeholderData: keepPreviousData,
  });
  const g = ledger.data;
  const side = (v: string) => (g?.account.normal === 'CREDIT' ? (v.startsWith('-') ? 'Dr' : 'Cr') : v.startsWith('-') ? 'Cr' : 'Dr');
  const balance = (v: string) => (v === '0.00' ? '—' : `${formatMoney(v.replace('-', ''))} ${side(v)}`);

  return (
    <div className="space-y-6">
      <PageHeader title="General ledger" description="Every posting to one account, with the running balance." />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem_10rem]">
            <Field id="gl-account" label="Account">
              <Select
                value={accountId}
                onChange={(e) => {
                  setParams({ accountId: e.target.value }, { replace: true });
                  setPage(1);
                }}
              >
                <option value="">Choose…</option>
                {accounts.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="gl-from" label="From">
              <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
            </Field>
            <Field id="gl-to" label="To">
              <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
            </Field>
          </div>
          {!accountId && <EmptyState title="Choose an account to see its postings" />}
          {ledger.isError && <QueryError error={ledger.error} onRetry={() => void ledger.refetch()} />}
          {accountId && ledger.isPending && <Skeleton className="h-64 w-full" />}
          {g && (
            <>
              <Table aria-busy={ledger.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Entry</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={5}>Opening balance at {formatDate(g.from)}</TableCell>
                    <TableCell className="text-right tabular-nums">{balance(g.openingBalance)}</TableCell>
                  </TableRow>
                  {g.lines.map((l, i) => (
                    <TableRow key={`${l.entryId}-${i}`}>
                      <TableCell className="whitespace-nowrap">{formatDate(l.date)}</TableCell>
                      <TableCell>
                        <Link to={`/accounting/journals/${l.entryId}`} className="font-mono hover:underline">
                          {l.number}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {l.description}
                        <span className="block text-xs text-muted-foreground">{[sourceLabel(l.sourceType), l.memo].filter(Boolean).join(' · ')}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{balance(l.balance)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                    <TableCell colSpan={3}>Closing balance at {formatDate(g.to)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(g.totalDebit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(g.totalCredit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{balance(g.closingBalance)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              {g.meta.total === 0 && <p className="text-sm text-muted-foreground">No postings in these dates.</p>}
              {g.meta.total > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={g.meta.total} onPageChange={setPage} />}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
