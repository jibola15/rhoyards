import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import type {
  BalanceSheet,
  CashFlowStatement,
  DataEnvelope,
  ProfitAndLoss,
  ReceivablesAging,
  ReceivablesAgingRow,
  ReportSection,
  TrialBalance,
} from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, Field, Input, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, PageHeader, QueryError } from '../../components/page';
import { api, qs } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/format';
import { today, yearStart } from '../accounting/api';

// ── Shared pieces ─────────────────────────────────────────────────────────

function useReport<T>(name: string, params: Record<string, string>) {
  return useQuery({
    queryKey: ['report', name, params],
    queryFn: ({ signal }) => api.get<DataEnvelope<T>>(`/reports/${name}${qs(params)}`, { signal }).then((r) => r.data),
    enabled: Object.values(params).every(Boolean),
  });
}

/** Negative amounts in brackets, the accountant's convention. */
const amount = (v: string) => (v.startsWith('-') ? `(${formatMoney(v.slice(1))})` : formatMoney(v));

function ReportShell({ title, description, filters, query, children }: { title: string; description: string; filters: ReactNode; query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button variant="outline" onClick={() => window.print()} className="print:hidden">
            <Printer />
            Print
          </Button>
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap gap-4 print:hidden">{filters}</div>
          {query.isError && query.error && <QueryError error={query.error} onRetry={() => void query.refetch()} />}
          {query.isPending && <Skeleton className="h-64 w-full" />}
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

const AsOf = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <Field id="report-asof" label="As at" className="w-44">
    <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} />
  </Field>
);

function Range({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return (
    <>
      <Field id="report-from" label="From" className="w-44">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field id="report-to" label="To" className="w-44">
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
    </>
  );
}

function AccountLink({ account, from, to }: { account: { id: string; code: string; name: string }; from?: string; to?: string }) {
  const { can } = useAuth();
  const label = (
    <>
      <span className="font-mono text-muted-foreground">{account.code}</span> {account.name}
    </>
  );
  return can('accounting.view') ? (
    <Link to={`/accounting/ledger${qs({ accountId: account.id, from, to })}`} className="hover:underline">
      {label}
    </Link>
  ) : (
    label
  );
}

const Row = ({ label, value, strong, indent }: { label: ReactNode; value: string; strong?: boolean; indent?: boolean }) => (
  <TableRow className={strong ? 'bg-muted/40 font-semibold hover:bg-muted/40' : ''}>
    <TableCell className={indent ? 'pl-6' : ''}>{label}</TableCell>
    <TableCell className="text-right tabular-nums">{amount(value)}</TableCell>
  </TableRow>
);

function SectionRows({ section, totalLabel, from, to }: { section: ReportSection; totalLabel?: string; from?: string; to?: string }) {
  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={2} className="pt-5 font-semibold">
          {section.label}
        </TableCell>
      </TableRow>
      {section.rows.length === 0 && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={2} className="pl-6 text-muted-foreground">
            None
          </TableCell>
        </TableRow>
      )}
      {section.rows.map((r) => (
        <Row key={r.account.id} indent label={<AccountLink account={r.account} {...(from ? { from } : {})} {...(to ? { to } : {})} />} value={r.amount} />
      ))}
      <Row label={totalLabel ?? `Total ${section.label.toLowerCase()}`} value={section.total} strong />
    </>
  );
}

const StatementTable = ({ children }: { children: ReactNode }) => (
  <Table className="max-w-3xl">
    <TableHeader>
      <TableRow>
        <TableHead />
        <TableHead className="w-48 text-right">₦</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>{children}</TableBody>
  </Table>
);

// ── Trial balance ─────────────────────────────────────────────────────────

export function TrialBalancePage() {
  const [asOf, setAsOf] = useState(today());
  const report = useReport<TrialBalance>('trial-balance', { asOf });
  const tb = report.data;
  return (
    <ReportShell title="Trial balance" description="Every account's balance on one date. Debits always equal credits." filters={<AsOf value={asOf} onChange={setAsOf} />} query={report}>
      {tb && (
        <>
          <Table className="max-w-4xl">
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="w-44 text-right">Debit</TableHead>
                <TableHead className="w-44 text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tb.rows.map((r) => (
                <TableRow key={r.account.id}>
                  <TableCell>
                    <AccountLink account={r.account} to={asOf} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.debit === '0.00' ? '' : formatMoney(r.debit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.credit === '0.00' ? '' : formatMoney(r.credit)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(tb.totals.debit)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(tb.totals.credit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {tb.rows.length === 0 && <EmptyState title="Nothing has been posted yet" />}
        </>
      )}
    </ReportShell>
  );
}

// ── Profit and loss ───────────────────────────────────────────────────────

export function ProfitLossPage() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const report = useReport<ProfitAndLoss>('profit-and-loss', { from, to });
  const pl = report.data;
  return (
    <ReportShell title="Profit and loss" description="Income less expenses for the period, from posted entries." filters={<Range from={from} to={to} setFrom={setFrom} setTo={setTo} />} query={report}>
      {pl && (
        <StatementTable>
          <SectionRows section={pl.revenue} from={from} to={to} />
          {pl.deductions.rows.length > 0 && <SectionRows section={pl.deductions} totalLabel="Total returns and discounts" from={from} to={to} />}
          <Row label="Net sales" value={pl.netSales} strong />
          <SectionRows section={pl.costOfSales} from={from} to={to} />
          <Row label="Gross profit" value={pl.grossProfit} strong />
          {pl.otherIncome.rows.length > 0 && <SectionRows section={pl.otherIncome} from={from} to={to} />}
          <SectionRows section={pl.operatingExpenses} from={from} to={to} />
          {pl.otherExpenses.rows.length > 0 && <SectionRows section={pl.otherExpenses} from={from} to={to} />}
          <Row label={pl.netProfit.startsWith('-') ? 'Net loss' : 'Net profit'} value={pl.netProfit} strong />
        </StatementTable>
      )}
    </ReportShell>
  );
}

// ── Balance sheet ─────────────────────────────────────────────────────────

export function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(today());
  const report = useReport<BalanceSheet>('balance-sheet', { asOf });
  const bs = report.data;
  return (
    <ReportShell title="Balance sheet" description="What the business owns and owes on one date." filters={<AsOf value={asOf} onChange={setAsOf} />} query={report}>
      {bs && (
        <>
          {!bs.balanced && <Alert variant="destructive">Assets do not equal liabilities plus equity. Please report this: it indicates a posting fault.</Alert>}
          <StatementTable>
            {bs.assets.map((s) => (
              <SectionRows key={s.key} section={s} to={asOf} />
            ))}
            <Row label="Total assets" value={bs.totalAssets} strong />
            {bs.liabilities.map((s) => (
              <SectionRows key={s.key} section={s} to={asOf} />
            ))}
            <Row label="Total liabilities" value={bs.totalLiabilities} strong />
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={2} className="pt-5 font-semibold">
                Equity
              </TableCell>
            </TableRow>
            {bs.equity.rows.map((r) => (
              <Row key={r.account.id} indent label={<AccountLink account={r.account} to={asOf} />} value={r.amount} />
            ))}
            <Row indent label="Profit not yet closed to retained earnings" value={bs.currentEarnings} />
            <Row label="Total equity" value={bs.totalEquity} strong />
            <Row label="Total liabilities and equity" value={bs.totalLiabilitiesAndEquity} strong />
          </StatementTable>
        </>
      )}
    </ReportShell>
  );
}

// ── Cash flow ─────────────────────────────────────────────────────────────

export function CashFlowPage() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const report = useReport<CashFlowStatement>('cash-flow', { from, to });
  const cf = report.data;
  return (
    <ReportShell
      title="Cash flow"
      description="Where cash came from and went, grouped by the other side of each cash entry. Cash means the accounts classified as cash and bank."
      filters={<Range from={from} to={to} setFrom={setFrom} setTo={setTo} />}
      query={report}
    >
      {cf && (
        <StatementTable>
          <Row label={`Cash at ${formatDate(cf.from)}`} value={cf.openingCash} strong />
          {[cf.operating, cf.investing, cf.financing].map((s) => (
            <SectionRows key={s.key} section={s} totalLabel={`Net cash from ${s.label.toLowerCase()}`} from={from} to={to} />
          ))}
          <Row label="Net change in cash" value={cf.netChange} strong />
          <Row label={`Cash at ${formatDate(cf.to)}`} value={cf.closingCash} strong />
          {cf.cashAccounts.map((c) => (
            <Row key={c.account.id} indent label={<AccountLink account={c.account} from={from} to={to} />} value={c.closing} />
          ))}
        </StatementTable>
      )}
    </ReportShell>
  );
}

// ── Aged receivables ──────────────────────────────────────────────────────

const AR_COLS: [keyof Omit<ReceivablesAgingRow, 'customer'>, string][] = [
  ['days0to30', '0–30 days'],
  ['days31to60', '31–60'],
  ['days61to90', '61–90'],
  ['over90', 'Over 90'],
  ['balance', 'Balance'],
];

export function ReceivablesAgingPage() {
  const [asOf, setAsOf] = useState(today());
  const report = useReport<ReceivablesAging>('receivables-aging', { asOf });
  const ar = report.data;
  const cell = (key: string, v: string, strong = false) => (
    <TableCell key={key} className={`text-right tabular-nums ${strong ? 'font-semibold' : ''}`}>
      {v === '0.00' ? '—' : formatMoney(v)}
    </TableCell>
  );
  return (
    <ReportShell title="Aged receivables" description="What customers owe on credit sales, by how long ago the sale was made." filters={<AsOf value={asOf} onChange={setAsOf} />} query={report}>
      {ar && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                {AR_COLS.map(([k, label]) => (
                  <TableHead key={k} className="text-right">
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ar.rows.map((r) => (
                <TableRow key={r.customer.id}>
                  <TableCell className="font-medium">{r.customer.name}</TableCell>
                  {AR_COLS.map(([k]) => cell(k, r[k], k === 'balance'))}
                </TableRow>
              ))}
              {ar.rows.length > 0 && (
                <TableRow className="bg-muted/40">
                  <TableCell className="font-semibold">Total</TableCell>
                  {AR_COLS.map(([k]) => cell(k, ar.totals[k], true))}
                </TableRow>
              )}
            </TableBody>
          </Table>
          {ar.rows.length === 0 && <EmptyState title="No customer owes anything" />}
          {ar.ledgerBalance !== ar.totals.balance && (
            <Alert variant="destructive">
              The Accounts receivable ledger shows {formatMoney(ar.ledgerBalance)}, which differs from the customer balances. Please report this.
            </Alert>
          )}
        </>
      )}
    </ReportShell>
  );
}
