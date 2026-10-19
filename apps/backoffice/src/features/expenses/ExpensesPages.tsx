import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Upload, X } from 'lucide-react';
import {
  dec,
  moneyInput,
  roundMoney,
  type DataEnvelope,
  type ExpenseCategoryRow,
  type ExpenseDetail,
  type ExpenseSummary,
  type TaxRateSummary,
} from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, Skeleton, toast } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { ConfirmAction } from '../../components/ConfirmAction';
import { DocumentList } from '../../components/DocumentList';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { useAccountOptions } from '../purchasing/api';
import { DocumentShell, InfoGrid } from '../purchasing/shared';

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Awaiting approval' },
  { value: 'POSTED', label: 'Posted' },
];
const isMoney = (v: string) => moneyInput.safeParse(v).success;
const today = () => new Date().toISOString().slice(0, 10);

export function ExpensesPage() {
  return (
    <DocumentList<ExpenseSummary>
      title="Expenses"
      description="Running costs paid in cash or from the bank. Bills to pay later go in as supplier invoices."
      queryKey="expenses"
      path="/expenses"
      statuses={STATUSES}
      searchPlaceholder="Search by number, payee or description"
      newLink={{ to: '/expenses/new', label: 'Record expense', permission: 'expenses.create' }}
      columns={[
        { header: 'Date', cell: (e) => formatDate(e.expenseDate) },
        {
          header: 'Number',
          cell: (e) => (
            <Link to={`/expenses/${e.id}`} className="font-mono font-medium hover:underline">
              {e.number}
            </Link>
          ),
        },
        { header: 'Payee', cell: (e) => e.payee },
        { header: 'Category', cell: (e) => e.category, className: 'hidden md:table-cell' },
        { header: 'Amount', cell: (e) => formatMoney(e.total), className: 'text-right tabular-nums' },
        { header: 'Status', cell: (e) => <StatusBadge status={e.status === 'SUBMITTED' ? 'PENDING_APPROVAL' : e.status} /> },
      ]}
    />
  );
}

type Attachment = { id: string; name: string; url: string };

function ExpenseForm({ existing, onSaved, onCancel }: { existing?: ExpenseDetail; onSaved: (e: ExpenseDetail) => void; onCancel?: () => void }) {
  const categories = useQuery({
    queryKey: ['expense-categories'],
    queryFn: ({ signal }) => api.get<DataEnvelope<ExpenseCategoryRow[]>>('/expense-categories', { signal }).then((r) => r.data.filter((c) => c.isActive)),
  });
  const rates = useQuery({
    queryKey: ['tax-rates'],
    queryFn: ({ signal }) => api.get<DataEnvelope<TaxRateSummary[]>>('/tax-rates', { signal }).then((r) => r.data.filter((t) => t.isActive && t.kind === 'STANDARD')),
  });
  const accounts = useAccountOptions('payment');
  const fileInput = useRef<HTMLInputElement>(null);
  const [v, setV] = useState({
    expenseDate: existing?.expenseDate ?? today(),
    categoryId: existing?.categoryId ?? '',
    payee: existing?.payee ?? '',
    description: existing?.description ?? '',
    total: existing?.total ?? '',
    taxRateId: existing?.taxRate?.id ?? '',
    paymentAccountId: existing?.paymentAccount.id ?? '',
    reference: existing?.reference ?? '',
  });
  const [files, setFiles] = useState<Attachment[]>(existing?.attachments.map((a) => ({ id: a.id, name: a.name, url: a.url })) ?? []);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const rate = rates.data?.find((r) => r.id === v.taxRateId);
  const tax = rate && isMoney(v.total) ? roundMoney(dec(v.total).times(rate.rate).dividedBy(dec(100).plus(rate.rate))) : dec(0);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.post<DataEnvelope<{ id: string; url: string }>>('/files/documents', form);
      setFiles((f) => [...f, { id: res.data.id, url: res.data.url, name: file.name }]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, taxRateId: v.taxRateId || null, reference: v.reference || null, attachmentIds: files.map((f) => f.id) };
      return existing ? api.put<DataEnvelope<ExpenseDetail>>(`/expenses/${existing.id}`, body) : api.post<DataEnvelope<ExpenseDetail>>('/expenses', body);
    },
    onSuccess: (res) => onSaved(res.data),
    onError: (e) => setError(e.message),
  });

  return (
    <div className="space-y-6">
      {error && <Alert variant="destructive">{error}</Alert>}
      {existing?.rejectedReason && <Alert variant="destructive">Sent back: {existing.rejectedReason}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <Field id="ex-date" label="Date paid">
            <Input type="date" value={v.expenseDate} onChange={set('expenseDate')} />
          </Field>
          <Field id="ex-category" label="Category">
            <Select value={v.categoryId} onChange={set('categoryId')}>
              <option value="">Choose…</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ex-payee" label="Paid to">
            <Input value={v.payee} onChange={set('payee')} />
          </Field>
          <Field id="ex-desc" label="What for">
            <Input value={v.description} onChange={set('description')} />
          </Field>
          <Field id="ex-total" label="Amount paid (₦)" description="Including any VAT.">
            <Input inputMode="decimal" value={v.total} onChange={set('total')} />
          </Field>
          <Field id="ex-vat" label="VAT on a VAT invoice" description={rate ? `Recoverable VAT: ${formatMoney(tax.toFixed(2))}` : 'Leave as “No VAT” without a VAT invoice.'}>
            <Select value={v.taxRateId} onChange={set('taxRateId')}>
              <option value="">No VAT</option>
              {rates.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({Number(r.rate)}%)
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ex-paidfrom" label="Paid from">
            <Select value={v.paymentAccountId} onChange={set('paymentAccountId')}>
              <option value="">Choose…</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ex-ref" label="Reference (receipt or transfer no.)">
            <Input value={v.reference} onChange={set('reference')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-sm font-medium">Receipts</p>
          <ul className="space-y-1 text-sm">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <Paperclip className="size-4 text-muted-foreground" aria-hidden="true" />
                <a href={f.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {f.name}
                </a>
                <Button variant="ghost" size="icon" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="hidden"
            aria-label="Attach a receipt"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" disabled={uploading || files.length >= 10} onClick={() => fileInput.current?.click()}>
            <Upload />
            {uploading ? 'Uploading…' : 'Attach a photo or PDF'}
          </Button>
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button disabled={save.isPending} onClick={() => (setError(null), save.mutate())}>
          {save.isPending ? 'Saving…' : 'Save draft'}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function ExpenseView({ expense, onEdit, onChanged }: { expense: ExpenseDetail; onEdit: () => void; onChanged: (e: ExpenseDetail | null) => void }) {
  const { can, session } = useAuth();
  const navigate = useNavigate();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const mine = session?.user.id === expense.createdById;
  const act = async (path: string, body: object, message: string) => {
    try {
      const res = await api.post<DataEnvelope<ExpenseDetail>>(`/expenses/${expense.id}/${path}`, body);
      onChanged(res.data);
      toast.success(message);
      setRejecting(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    }
  };
  const canEdit = expense.status === 'DRAFT' && (mine || can('expenses.approve'));

  return (
    <div className="space-y-6">
      {expense.rejectedReason && expense.status === 'DRAFT' && <Alert variant="destructive">Sent back: {expense.rejectedReason}</Alert>}
      <Card>
        <CardContent className="space-y-4 pt-5">
          <InfoGrid
            items={[
              ['Status', <StatusBadge key="s" status={expense.status === 'SUBMITTED' ? 'PENDING_APPROVAL' : expense.status} />],
              ['Date paid', formatDate(expense.expenseDate)],
              ['Paid to', expense.payee],
              ['Category', `${expense.category} (${expense.account.code})`],
              ['Amount', <strong key="a">{formatMoney(expense.total)}</strong>],
              ['VAT recoverable', expense.tax === '0.00' ? '—' : formatMoney(expense.tax)],
              ['Paid from', expense.paymentAccount.name],
              ['Recorded by', expense.createdBy],
              ...(expense.postedAt ? ([['Posted', `${formatDateTime(expense.postedAt)} · ${expense.approvedBy ?? ''}`]] as [string, string][]) : []),
              ...(expense.reference ? ([['Reference', expense.reference]] as [string, string][]) : []),
            ]}
          />
          <p className="text-sm">{expense.description}</p>
          {expense.attachments.length > 0 && (
            <ul className="space-y-1 text-sm">
              {expense.attachments.map((a) => (
                <li key={a.id}>
                  <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                    <Paperclip className="size-4" aria-hidden="true" /> {a.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <>
                <Button onClick={() => void act('submit', {}, 'Submitted for approval')}>Submit for approval</Button>
                <Button variant="outline" onClick={onEdit}>
                  Edit
                </Button>
                <ConfirmAction
                  variant="outline"
                  title="Delete this draft?"
                  description="Nothing has been posted."
                  confirmLabel="Delete"
                  destructive
                  onConfirm={async () => {
                    await api.delete(`/expenses/${expense.id}`);
                    onChanged(null);
                    navigate('/expenses', { replace: true });
                  }}
                >
                  Delete
                </ConfirmAction>
              </>
            )}
            {expense.status === 'SUBMITTED' && can('expenses.approve') && (
              <>
                <ConfirmAction title="Approve and post?" description={`Posts ${formatMoney(expense.total)} paid from ${expense.paymentAccount.name}. It cannot be edited afterwards.`} confirmLabel="Approve and post" onConfirm={() => act('approve', {}, 'Expense posted')}>
                  Approve and post
                </ConfirmAction>
                <Button variant="outline" onClick={() => setRejecting(true)}>
                  Send back
                </Button>
              </>
            )}
            {expense.journalEntryId && can('accounting.view') && (
              <Link to={`/accounting/journals/${expense.journalEntryId}`} className="inline-flex items-center text-sm underline">
                View journal
              </Link>
            )}
          </div>
        </CardContent>
      </Card>
      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send back to draft</DialogTitle>
            <DialogDescription>The person who recorded it sees your reason and can correct and resubmit.</DialogDescription>
          </DialogHeader>
          <Field id="ex-reject" label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button disabled={reason.trim().length < 3} onClick={() => void act('reject', { reason }, 'Sent back to draft')}>
              Send back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ExpensePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const expense = useQuery({
    queryKey: ['expenses', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<ExpenseDetail>>(`/expenses/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
  const changed = (e: ExpenseDetail | null) => {
    if (e) queryClient.setQueryData(['expenses', 'detail', e.id], e);
    void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
    for (const k of ['journals', 'report', 'accounts']) void queryClient.invalidateQueries({ queryKey: [k] });
  };
  return (
    <DocumentShell back={{ to: '/expenses', label: 'Expenses' }} title={id ? (expense.data ? `Expense ${expense.data.number}` : 'Expense') : 'Record expense'} isNew={!id} query={expense}>
      {!id && (
        <ExpenseForm
          onSaved={(e) => {
            changed(e);
            toast.success('Saved as draft. Submit it for approval when ready.');
            navigate(`/expenses/${e.id}`, { replace: true });
          }}
        />
      )}
      {id && expense.isPending && <Skeleton className="h-64 w-full" />}
      {expense.data &&
        (editing ? (
          <ExpenseForm
            existing={expense.data}
            onSaved={(e) => {
              changed(e);
              setEditing(false);
              toast.success('Draft saved');
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <ExpenseView expense={expense.data} onEdit={() => setEditing(true)} onChanged={changed} />
        ))}
    </DocumentShell>
  );
}
