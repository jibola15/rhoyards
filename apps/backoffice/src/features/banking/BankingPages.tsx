import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dec, sum, type DataEnvelope, type JournalDetail, type ReconciliationDetail, type ReconciliationSummary } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
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
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { useAccountOptions } from '../purchasing/api';
import { DocumentShell, InfoGrid } from '../purchasing/shared';

const today = () => new Date().toISOString().slice(0, 10);

function StartCard() {
  const navigate = useNavigate();
  const accounts = useAccountOptions('payment');
  const [v, setV] = useState({ accountId: '', statementDate: today(), statementBalance: '' });
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<DataEnvelope<ReconciliationDetail>>('/reconciliations', v),
    onSuccess: (res) => navigate(`/banking/reconciliations/${res.data.id}`),
    onError: (e) => setError(e.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reconcile to a statement</CardTitle>
        <CardDescription>Tick the entries that appear on the bank statement (or the cash count) until the difference is nil.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <Alert variant="destructive">{error}</Alert>}
        <Field id="rc-account" label="Account">
          <Select value={v.accountId} onChange={(e) => setV({ ...v, accountId: e.target.value })}>
            <option value="">Choose…</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="rc-date" label="Statement date">
            <Input type="date" value={v.statementDate} onChange={(e) => setV({ ...v, statementDate: e.target.value })} />
          </Field>
          <Field id="rc-balance" label="Closing balance (₦)" description="Negative if overdrawn.">
            <Input inputMode="decimal" value={v.statementBalance} onChange={(e) => setV({ ...v, statementBalance: e.target.value })} />
          </Field>
        </div>
        <Button disabled={start.isPending || !v.accountId || !v.statementBalance} onClick={() => (setError(null), start.mutate())}>
          Start
        </Button>
      </CardContent>
    </Card>
  );
}

function SettlementCard() {
  const queryClient = useQueryClient();
  const accounts = useAccountOptions('payment');
  const empty = { settlementDate: today(), clearingAccountId: '', bankAccountId: '', amount: '', fees: '0', reference: '' };
  const [v, setV] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post<DataEnvelope<JournalDetail>>('/settlements', v),
    onSuccess: (res) => {
      toast.success(`Settlement posted as ${res.data.number}`);
      setV(empty);
      for (const k of ['journals', 'report', 'accounts', 'reconciliation']) void queryClient.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => setError(e.message),
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Card settlement</CardTitle>
        <CardDescription>Card or gateway takings paid into the bank, with the charges deducted.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {error && <Alert variant="destructive" className="sm:col-span-2">{error}</Alert>}
        <Field id="st-from" label="From (clearing account)">
          <Select value={v.clearingAccountId} onChange={set('clearingAccountId')}>
            <option value="">Choose…</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="st-to" label="Into (bank)">
          <Select value={v.bankAccountId} onChange={set('bankAccountId')}>
            <option value="">Choose…</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="st-amount" label="Amount settled (₦)">
          <Input inputMode="decimal" value={v.amount} onChange={set('amount')} />
        </Field>
        <Field id="st-fees" label="Charges deducted (₦)">
          <Input inputMode="decimal" value={v.fees} onChange={set('fees')} />
        </Field>
        <Field id="st-date" label="Date">
          <Input type="date" value={v.settlementDate} onChange={set('settlementDate')} />
        </Field>
        <Field id="st-ref" label="Reference">
          <Input value={v.reference} onChange={set('reference')} />
        </Field>
        <Button className="sm:col-span-2 sm:w-fit" disabled={save.isPending || !v.amount || !v.clearingAccountId || !v.bankAccountId} onClick={() => (setError(null), save.mutate())}>
          Post settlement
        </Button>
      </CardContent>
    </Card>
  );
}

export function ReconciliationsPage() {
  const { can } = useAuth();
  const list = useQuery({
    queryKey: ['reconciliation', 'list'],
    queryFn: ({ signal }) => api.get<DataEnvelope<ReconciliationSummary[]>>('/reconciliations', { signal }).then((r) => r.data),
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Bank and cash reconciliation" description="Prove the ledger's bank and cash balances against statements and counts." />
      {can('reconciliation.manage') && (
        <div className="grid gap-6 xl:grid-cols-2">
          <StartCard />
          <SettlementCard />
        </div>
      )}
      <Card>
        <CardContent className="pt-5">
          {list.isError && <QueryError error={list.error} onRetry={() => void list.refetch()} />}
          {list.isPending && <Skeleton className="h-32 w-full" />}
          {list.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Statement date</TableHead>
                  <TableHead className="text-right">Statement balance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link to={`/banking/reconciliations/${r.id}`} className="hover:underline">
                        {r.account.code} {r.account.name}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(r.statementDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(r.statementBalance)}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                  </TableRow>
                ))}
                {list.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No reconciliations yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ReconciliationPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rec = useQuery({
    queryKey: ['reconciliation', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<ReconciliationDetail>>(`/reconciliations/${id}`, { signal }).then((r) => r.data),
  });
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const r = rec.data;
  const cleared = ticked ?? new Set(r?.lines.filter((l) => l.cleared).map((l) => l.journalLineId) ?? []);
  const open = r?.status === 'IN_PROGRESS' && can('reconciliation.manage');
  const clearedBalance = r ? dec(r.openingBalance).plus(sum(r.lines.filter((l) => cleared.has(l.journalLineId)).map((l) => dec(l.debit).minus(l.credit)))) : dec(0);
  const difference = r ? dec(r.statementBalance).minus(clearedBalance) : dec(0);
  const dirty = Boolean(ticked);

  const save = async () => {
    const res = await api.put<DataEnvelope<ReconciliationDetail>>(`/reconciliations/${id}/lines`, { cleared: [...cleared] });
    queryClient.setQueryData(['reconciliation', id], res.data);
    setTicked(null);
    return res.data;
  };
  const complete = useMutation({
    mutationFn: async () => {
      if (dirty) await save();
      return api.post<DataEnvelope<ReconciliationDetail>>(`/reconciliations/${id}/complete`);
    },
    onSuccess: (res) => {
      queryClient.setQueryData(['reconciliation', id], res.data);
      void queryClient.invalidateQueries({ queryKey: ['reconciliation', 'list'] });
      toast.success('Reconciliation completed');
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DocumentShell back={{ to: '/banking/reconciliations', label: 'Reconciliation' }} title={r ? `${r.account.name} to ${formatDate(r.statementDate)}` : 'Reconciliation'} isNew={false} query={rec}>
      {r && (
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-4 pt-5">
              <InfoGrid
                items={[
                  ['Opening (last statement)', formatMoney(r.openingBalance)],
                  ['Statement balance', formatMoney(r.statementBalance)],
                  ['Cleared balance', formatMoney(clearedBalance.toFixed(2))],
                  ['Difference', <strong key="d" className={difference.isZero() ? '' : 'text-destructive'}>{formatMoney(difference.toFixed(2))}</strong>],
                ]}
              />
              {r.status === 'COMPLETED' && <Alert>Completed {formatDateTime(r.completedAt)} by {r.completedBy}. These lines are cleared for good.</Alert>}
              {open && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={!dirty} onClick={() => void save().then(() => toast.success('Saved'))}>
                    Save ticks
                  </Button>
                  <Button disabled={complete.isPending || !difference.isZero()} onClick={() => complete.mutate()}>
                    Complete
                  </Button>
                  <ConfirmAction
                    variant="ghost"
                    title="Discard this reconciliation?"
                    description="The ticks are removed; nothing in the ledger changes."
                    confirmLabel="Discard"
                    destructive
                    onConfirm={async () => {
                      await api.delete(`/reconciliations/${id}`);
                      void queryClient.invalidateQueries({ queryKey: ['reconciliation', 'list'] });
                      navigate('/banking/reconciliations', { replace: true });
                    }}
                  >
                    Discard
                  </ConfirmAction>
                </div>
              )}
              {open && !difference.isZero() && <p className="text-xs text-muted-foreground">Missing bank charges or interest? Post them as a journal first; they then appear here to tick.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <span className="sr-only">Cleared</span>
                    </TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Entry</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.lines.map((l) => (
                    <TableRow key={l.journalLineId}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Cleared: ${l.number} ${l.description}`}
                          disabled={!open}
                          checked={cleared.has(l.journalLineId)}
                          onChange={(e) => {
                            const next = new Set(cleared);
                            if (e.target.checked) next.add(l.journalLineId);
                            else next.delete(l.journalLineId);
                            setTicked(next);
                          }}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(l.date)}</TableCell>
                      <TableCell>
                        <Link to={`/accounting/journals/${l.entryId}`} className="font-mono hover:underline">
                          {l.number}
                        </Link>{' '}
                        {l.description}
                        {l.memo && <span className="block text-xs text-muted-foreground">{l.memo}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {r.lines.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No entries on this account up to the statement date.</p>}
            </CardContent>
          </Card>
        </div>
      )}
    </DocumentShell>
  );
}
