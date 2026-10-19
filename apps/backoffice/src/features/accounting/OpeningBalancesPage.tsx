import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { dec, moneyInput, sum, type AccountRef, type DataEnvelope, type JournalDetail, type OpeningBalancesState } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
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
import { PageHeader, QueryError } from '../../components/page';
import { api } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/format';
import { TYPE_LABELS, today, useRefreshLedger } from './api';

const isMoney = (v: string) => moneyInput.safeParse(v).success;
const amount = (v: string | undefined) => (v && isMoney(v) ? dec(v) : dec(0));
type Entry = { debit: string; credit: string };

function Entered({ entry }: { entry: JournalDetail }) {
  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <Alert>
          Opening balances were posted on {formatDate(entry.entryDate)} in{' '}
          <Link to={`/accounting/journals/${entry.id}`} className="font-mono underline">
            {entry.number}
          </Link>
          . To change them, reverse that entry (from its page) and enter them again here.
        </Alert>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entry.lines.map((l) => (
              <TableRow key={l.lineNo}>
                <TableCell>
                  <span className="font-mono">{l.account.code}</span> {l.account.name}
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                <TableCell className="text-right tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Wizard({ accounts, onPosted }: { accounts: AccountRef[]; onPosted: () => void }) {
  const [entryDate, setEntryDate] = useState(today());
  const [values, setValues] = useState<Record<string, Entry>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, side: keyof Entry, v: string) => setValues((s) => ({ ...s, [id]: { debit: '', credit: '', ...s[id], [side]: v } }));
  const entries = Object.entries(values).filter(([, e]) => amount(e.debit).gt(0) || amount(e.credit).gt(0));
  const invalid = Object.values(values).some((e) => (e.debit && !isMoney(e.debit)) || (e.credit && !isMoney(e.credit)) || (amount(e.debit).gt(0) && amount(e.credit).gt(0)));
  const totalDebit = sum(entries.map(([, e]) => amount(e.debit)));
  const totalCredit = sum(entries.map(([, e]) => amount(e.credit)));
  const difference = totalDebit.minus(totalCredit);

  const mutation = useMutation({
    mutationFn: () => api.post<DataEnvelope<JournalDetail>>('/accounting/opening-balances', { entryDate, lines: entries.map(([accountId, e]) => ({ accountId, ...e })) }),
    onSuccess: (res) => {
      toast.success(`Opening balances posted as ${res.data.number}`);
      onPosted();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not post'),
  });

  return (
    <div className="space-y-6">
      <Alert>
        Enter each account's balance on the day you start using the system. Stock is entered as an <Link to="/inventory/adjustments/new" className="underline">opening-stock adjustment</Link> (it values each product); customer and supplier balances belong to their own accounts and are not entered here. Any difference goes to Opening balance equity.
      </Alert>
      {error && <Alert variant="destructive">{error}</Alert>}
      <Card>
        <CardContent className="space-y-4 pt-5">
          <Field id="ob-date" label="Balances as at" className="w-48">
            <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="w-40 text-right">Debit</TableHead>
                <TableHead className="w-40 text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const).flatMap((type) => {
                const group = accounts.filter((a) => a.type === type);
                if (group.length === 0) return [];
                return [
                  <TableRow key={type} className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={3} className="font-semibold">
                      {TYPE_LABELS[type]}
                    </TableCell>
                  </TableRow>,
                  ...group.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <span className="font-mono">{a.code}</span> {a.name}
                      </TableCell>
                      {(['debit', 'credit'] as const).map((side) => (
                        <TableCell key={side}>
                          <Input
                            inputMode="decimal"
                            aria-label={`${a.name} ${side}`}
                            className="text-right"
                            value={values[a.id]?.[side] ?? ''}
                            onChange={(e) => set(a.id, side, e.target.value)}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  )),
                ];
              })}
            </TableBody>
          </Table>
          <dl className="ml-auto grid max-w-sm grid-cols-2 gap-1 text-sm">
            <dt className="text-muted-foreground">Debits</dt>
            <dd className="text-right tabular-nums">{formatMoney(totalDebit.toFixed(2))}</dd>
            <dt className="text-muted-foreground">Credits</dt>
            <dd className="text-right tabular-nums">{formatMoney(totalCredit.toFixed(2))}</dd>
            <dt className="font-medium">To Opening balance equity</dt>
            <dd className="text-right font-semibold tabular-nums">
              {formatMoney(difference.abs().toFixed(2))} {difference.isZero() ? '' : difference.gt(0) ? 'Cr' : 'Dr'}
            </dd>
          </dl>
        </CardContent>
      </Card>
      <Button disabled={mutation.isPending || invalid || entries.length === 0} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Posting…' : 'Post opening balances'}
      </Button>
    </div>
  );
}

export function OpeningBalancesPage() {
  const { can } = useAuth();
  const refresh = useRefreshLedger();
  const state = useQuery({
    queryKey: ['opening-balances'],
    queryFn: ({ signal }) => api.get<DataEnvelope<OpeningBalancesState>>('/accounting/opening-balances', { signal }).then((r) => r.data),
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Opening balances" description="Starting balances carried over from your previous records." />
      {state.isError && <QueryError error={state.error} onRetry={() => void state.refetch()} />}
      {state.isPending && <Skeleton className="h-96 w-full" />}
      {state.data?.current && <Entered entry={state.data.current} />}
      {state.data && !state.data.current && (can('journals.post') ? <Wizard accounts={state.data.accounts} onPosted={() => void refresh()} /> : <Alert>No opening balances have been entered yet.</Alert>)}
    </div>
  );
}
