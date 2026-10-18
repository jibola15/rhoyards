import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Banknote, ClipboardList, FileText } from 'lucide-react';
import type { DataEnvelope, SupplierStatement, SupplierSummary } from '@rhoyards/shared';
import {
  Badge,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, PageHeader, QueryError } from '../../components/page';
import { api, qs } from '../../lib/api';
import { formatDate, formatMoney } from '../../lib/format';

const TYPE_LINK: Record<string, (id: string) => string> = {
  INVOICE: (id) => `/purchasing/invoices/${id}`,
  PAYMENT: (id) => `/purchasing/payments/${id}`,
  RETURN: (id) => `/purchasing/returns/${id}`,
};
const TYPE_LABEL: Record<string, string> = { INVOICE: 'Invoice', PAYMENT: 'Payment', RETURN: 'Return credit' };

export function SupplierDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const supplier = useQuery({
    queryKey: ['suppliers', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<SupplierSummary>>(`/suppliers/${id}`, { signal }).then((r) => r.data),
  });
  const canSeeAccount = can('purchasing.view') || can('supplier_payments.manage');
  const statement = useQuery({
    queryKey: ['supplier-statement', id, from, to],
    queryFn: ({ signal }) => api.get<DataEnvelope<SupplierStatement>>(`/suppliers/${id}/statement${qs({ from, to })}`, { signal }).then((r) => r.data),
    enabled: canSeeAccount,
  });

  if (supplier.isError) return <QueryError error={supplier.error} onRetry={() => void supplier.refetch()} />;
  if (!supplier.data) return <Skeleton className="h-64 w-full" />;
  const s = supplier.data;
  const balance = statement.data?.closingBalance;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/suppliers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Suppliers
      </Link>
      <PageHeader
        title={s.name}
        description={`${s.code} · ${s.paymentTermsDays === 0 ? 'Pay on delivery' : `${s.paymentTermsDays}-day terms`}`}
        actions={
          <>
            {can('purchasing.manage') && (
              <Link to="/purchasing/orders/new" className={buttonVariants({ variant: 'outline' })}>
                <ClipboardList />
                New order
              </Link>
            )}
            {can('supplier_invoices.manage') && (
              <Link to={`/purchasing/invoices/new?supplierId=${s.id}`} className={buttonVariants({ variant: 'outline' })}>
                <FileText />
                Enter invoice
              </Link>
            )}
            {can('supplier_payments.manage') && (
              <Link to={`/purchasing/payments/new?supplierId=${s.id}`} className={buttonVariants()}>
                <Banknote />
                Record payment
              </Link>
            )}
          </>
        }
      />
      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Balance owed</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{balance !== undefined ? formatMoney(balance) : '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">{balance !== undefined && Number(balance) < 0 ? 'The supplier owes you this credit.' : 'Posted invoices less payments and return credits.'}</CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardContent className="grid gap-3 pt-5 text-sm sm:grid-cols-2">
            <div>
              <div className="text-muted-foreground">Contact</div>
              {s.contactName ?? '—'}
              <div className="text-muted-foreground">{[s.phone, s.email].filter(Boolean).join(' · ')}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Address</div>
              {s.address ?? '—'}
            </div>
            <div>
              <div className="text-muted-foreground">TIN</div>
              {s.taxId ?? '—'}
            </div>
            <div>{!s.isActive && <Badge variant="outline">Inactive</Badge>}</div>
          </CardContent>
        </Card>
      </div>

      {canSeeAccount && (
        <Card>
          <CardHeader className="flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <CardTitle>Statement</CardTitle>
            <div className="flex gap-2">
              <Field id="st-from" label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field id="st-to" label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>
          </CardHeader>
          <CardContent>
            {statement.isError && <QueryError error={statement.error} onRetry={() => void statement.refetch()} />}
            {statement.isPending && <Skeleton className="h-32 w-full" />}
            {statement.data && (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead className="hidden md:table-cell">Reference</TableHead>
                      <TableHead className="text-right">Charged</TableHead>
                      <TableHead className="text-right">Paid / credited</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {from && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground">
                          Balance brought forward
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(statement.data.openingBalance)}</TableCell>
                      </TableRow>
                    )}
                    {statement.data.lines.map((l) => (
                      <TableRow key={`${l.type}-${l.id}`}>
                        <TableCell className="whitespace-nowrap">{formatDate(l.date)}</TableCell>
                        <TableCell>
                          {TYPE_LABEL[l.type]}{' '}
                          <Link to={TYPE_LINK[l.type]!(l.id)} className="font-mono text-xs hover:underline">
                            {l.number}
                          </Link>
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs md:table-cell">{l.reference ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.credit !== '0.00' ? formatMoney(l.credit) : ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.debit !== '0.00' ? formatMoney(l.debit) : ''}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatMoney(l.balance)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {statement.data.lines.length === 0 && <EmptyState title="No invoices, payments or returns in this period" />}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
