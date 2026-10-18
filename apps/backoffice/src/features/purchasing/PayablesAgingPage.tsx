import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { DataEnvelope, PayablesAgingRow } from '@rhoyards/shared';
import { Card, CardContent, Field, Input, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { EmptyState, PageHeader, QueryError } from '../../components/page';
import { api, qs } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { today } from './api';

interface Aging {
  asOf: string;
  rows: PayablesAgingRow[];
  totals: Omit<PayablesAgingRow, 'supplier'>;
}

const COLS: [keyof Omit<PayablesAgingRow, 'supplier'>, string][] = [
  ['current', 'Not yet due'],
  ['days1to30', '1–30 days'],
  ['days31to60', '31–60'],
  ['days61to90', '61–90'],
  ['over90', 'Over 90'],
  ['unappliedCredits', 'Credits'],
  ['balance', 'Balance'],
];

export function PayablesAgingPage() {
  const [asOf, setAsOf] = useState(today());
  const aging = useQuery({
    queryKey: ['payables-aging', asOf],
    queryFn: ({ signal }) => api.get<DataEnvelope<Aging>>(`/reports/payables-aging${qs({ asOf })}`, { signal }).then((r) => r.data),
  });
  const cell = (key: string, v: string, strong = false) => (
    <TableCell key={key} className={`text-right tabular-nums ${strong ? 'font-semibold' : ''}`}>
      {v === '0.00' ? '—' : formatMoney(v)}
    </TableCell>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Aged payables" description="What you owe each supplier, by how far past the due date. Credits are payments not yet applied and return credits." />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <Field id="aging-asof" label="As of" className="w-48">
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} />
          </Field>
          {aging.isError && <QueryError error={aging.error} onRetry={() => void aging.refetch()} />}
          {aging.isPending && <Skeleton className="h-40 w-full" />}
          {aging.data && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Supplier</TableHead>
                    {COLS.map(([k, label]) => (
                      <TableHead key={k} className="text-right">
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aging.data.rows.map((r) => (
                    <TableRow key={r.supplier.id}>
                      <TableCell>
                        <Link to={`/suppliers/${r.supplier.id}`} className="font-medium hover:underline">
                          {r.supplier.name}
                        </Link>
                      </TableCell>
                      {COLS.map(([k]) => cell(k, k === 'unappliedCredits' && r[k] !== '0.00' ? `-${r[k]}` : r[k], k === 'balance'))}
                    </TableRow>
                  ))}
                  {aging.data.rows.length > 0 && (
                    <TableRow className="bg-muted/40">
                      <TableCell className="font-semibold">Total</TableCell>
                      {COLS.map(([k]) => cell(k, k === 'unappliedCredits' && aging.data.totals[k] !== '0.00' ? `-${aging.data.totals[k]}` : aging.data.totals[k], true))}
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              {aging.data.rows.length === 0 && <EmptyState title="Nothing owed to suppliers" />}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
