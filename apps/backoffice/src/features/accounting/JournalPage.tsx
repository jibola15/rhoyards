import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { dec, moneyInput, sum, type AccountRow, type DataEnvelope, type JournalDetail } from '@rhoyards/shared';
import {
  Alert,
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
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { DocumentShell, InfoGrid } from '../purchasing/shared';
import { sourceLabel, today, useAccounts, useRefreshLedger } from './api';

const isMoney = (v: string) => moneyInput.safeParse(v).success;
const amount = (v: string) => (isMoney(v) ? dec(v) : dec(0));

const lineSchema = z
  .object({ accountId: z.string().min(1, 'Choose an account'), debit: z.string(), credit: z.string(), memo: z.string().max(200) })
  .superRefine((l, ctx) => {
    for (const side of ['debit', 'credit'] as const) {
      if (l[side] !== '' && !isMoney(l[side])) ctx.addIssue({ code: 'custom', path: [side], message: 'Enter an amount' });
    }
    if (amount(l.debit).gt(0) === amount(l.credit).gt(0)) ctx.addIssue({ code: 'custom', path: ['debit'], message: 'Enter a debit or a credit' });
  });
const formSchema = z
  .object({
    entryDate: z.string().min(1, 'Enter the date'),
    description: z.string().trim().min(1, 'Describe the entry').max(300),
    lines: z.array(lineSchema).min(2, 'A journal needs at least two lines'),
  })
  .superRefine((v, ctx) => {
    const d = sum(v.lines.map((l) => amount(l.debit)));
    const c = sum(v.lines.map((l) => amount(l.credit)));
    if (!d.equals(c)) ctx.addIssue({ code: 'custom', path: ['lines'], message: `Debits and credits differ by ${formatMoney(d.minus(c).abs().toFixed(2))}` });
  });
type FormValues = z.infer<typeof formSchema>;
const blankLine = { accountId: '', debit: '', credit: '', memo: '' };

/** Links an automatic entry back to the document that made it. */
const SOURCE_PATHS: Record<string, string> = {
  SALE: '/sales',
  CASHIER_SHIFT: '/pos/shifts',
  STOCK_ADJUSTMENT: '/inventory/adjustments',
  GOODS_RECEIPT: '/purchasing/receipts',
  SUPPLIER_INVOICE: '/purchasing/invoices',
  SUPPLIER_PAYMENT: '/purchasing/payments',
  PURCHASE_RETURN: '/purchasing/returns',
};

type EditorProps = { existing?: JournalDetail; onSaved: (j: JournalDetail) => void; onCancel?: () => void };

/** The account selects need their options before the form mounts, or an existing draft would show blank accounts. */
function JournalEditor(props: EditorProps) {
  const accounts = useAccounts();
  if (accounts.isError) return <Alert variant="destructive">{accounts.error.message}</Alert>;
  if (!accounts.data) return <Skeleton className="h-64 w-full" />;
  return <JournalForm {...props} options={accounts.data.filter((a) => a.isActive && a.isPostable && !a.isControl)} />;
}

function JournalForm({ existing, onSaved, onCancel, options }: EditorProps & { options: AccountRow[] }) {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, control, handleSubmit, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: existing
      ? {
          entryDate: existing.entryDate,
          description: existing.description,
          lines: existing.lines.map((l) => ({
            accountId: l.account.id,
            debit: l.debit === '0.00' ? '' : l.debit,
            credit: l.credit === '0.00' ? '' : l.credit,
            memo: l.memo ?? '',
          })),
        }
      : { entryDate: today(), description: '', lines: [blankLine, blankLine] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const totalDebit = sum(lines.map((l) => amount(l.debit)));
  const totalCredit = sum(lines.map((l) => amount(l.credit)));
  const difference = totalDebit.minus(totalCredit);

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      existing ? api.put<DataEnvelope<JournalDetail>>(`/accounting/journals/${existing.id}`, v) : api.post<DataEnvelope<JournalDetail>>('/accounting/journals', v),
    onSuccess: (res) => {
      toast.success('Draft saved. Post it to update the ledger.');
      onSaved(res.data);
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, ['entryDate', 'description'])),
  });
  const e = formState.errors;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-[12rem_1fr]">
          <Field id="j-date" label="Date" error={e.entryDate?.message}>
            <Input type="date" {...register('entryDate')} />
          </Field>
          <Field id="j-desc" label="Description" error={e.description?.message}>
            <Input {...register('description')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {fields.map((f, i) => (
            <div key={f.id} className="grid items-end gap-2 rounded-md border p-3 md:grid-cols-[1fr_8rem_8rem_1fr_auto]">
              <Field id={`jl-${i}-acc`} label="Account" error={e.lines?.[i]?.accountId?.message}>
                <Select {...register(`lines.${i}.accountId`)}>
                  <option value="">Choose…</option>
                  {options.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={`jl-${i}-dr`} label="Debit" error={e.lines?.[i]?.debit?.message}>
                <Input inputMode="decimal" {...register(`lines.${i}.debit`)} />
              </Field>
              <Field id={`jl-${i}-cr`} label="Credit" error={e.lines?.[i]?.credit?.message}>
                <Input inputMode="decimal" {...register(`lines.${i}.credit`)} />
              </Field>
              <Field id={`jl-${i}-memo`} label="Memo">
                <Input {...register(`lines.${i}.memo`)} />
              </Field>
              <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={fields.length <= 2} onClick={() => remove(i)}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => append(blankLine)}>
            <Plus />
            Add line
          </Button>
          <p className="text-xs text-muted-foreground">Customer, supplier and stock accounts are kept by their own ledgers and are not offered here.</p>
          <dl className="ml-auto grid max-w-xs grid-cols-2 gap-1 pt-2 text-sm">
            <dt className="text-muted-foreground">Debits</dt>
            <dd className="text-right tabular-nums">{formatMoney(totalDebit.toFixed(2))}</dd>
            <dt className="text-muted-foreground">Credits</dt>
            <dd className="text-right tabular-nums">{formatMoney(totalCredit.toFixed(2))}</dd>
            <dt className="font-medium">Difference</dt>
            <dd className={`text-right font-semibold tabular-nums ${difference.isZero() ? '' : 'text-destructive'}`}>{formatMoney(difference.abs().toFixed(2))}</dd>
          </dl>
          {e.lines?.root?.message && (
            <p role="alert" className="text-right text-sm font-medium text-destructive">
              {e.lines.root.message}
            </p>
          )}
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save draft'}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ReverseDialog({ journal, open, onOpenChange, onDone }: { journal: JournalDetail; open: boolean; onOpenChange: (o: boolean) => void; onDone: (j: JournalDetail) => void }) {
  const [entryDate, setEntryDate] = useState(today());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => api.post<DataEnvelope<JournalDetail>>(`/accounting/journals/${journal.id}/reverse`, { entryDate, reason }),
    onSuccess: (res) => onDone(res.data),
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not reverse'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse {journal.number}?</DialogTitle>
          <DialogDescription>A mirror-image entry is posted on the date you choose. The original stays in the ledger, marked as reversed.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <Field id="rev-date" label="Reversal date">
            <Input type="date" value={entryDate} onChange={(ev) => setEntryDate(ev.target.value)} />
          </Field>
          <Field id="rev-reason" label="Reason">
            <Input value={reason} onChange={(ev) => setReason(ev.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={mutation.isPending || reason.trim().length < 3} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Reversing…' : 'Post reversal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JournalView({ journal, onEdit, onChanged }: { journal: JournalDetail; onEdit: () => void; onChanged: (j: JournalDetail | null) => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [reversing, setReversing] = useState(false);
  const isDraft = journal.status === 'DRAFT';
  const isManual = journal.sourceType === 'MANUAL';
  const sourcePath = journal.sourceId && SOURCE_PATHS[journal.sourceType];

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    }
  };
  const post = () =>
    act(async () => {
      const res = await api.post<DataEnvelope<JournalDetail>>(`/accounting/journals/${journal.id}/post`);
      toast.success(`${res.data.number} posted`);
      onChanged(res.data);
    });
  const remove = () =>
    act(async () => {
      await api.delete(`/accounting/journals/${journal.id}`);
      toast.success('Draft deleted');
      onChanged(null);
      navigate('/accounting/journals', { replace: true });
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 pt-5">
          <InfoGrid
            items={[
              ['Status', <StatusBadge key="s" status={journal.status} />],
              ['Date', formatDate(journal.entryDate)],
              ['Period', `${journal.period.name}${journal.period.status === 'CLOSED' ? ' (closed)' : ''}`],
              ['Source', sourcePath ? <Link key="src" to={`${sourcePath}/${journal.sourceId}`} className="hover:underline">{sourceLabel(journal.sourceType)}</Link> : sourceLabel(journal.sourceType)],
              ['Created', `${formatDateTime(journal.createdAt)} · ${journal.createdBy}`],
              ...(journal.postedAt ? ([['Posted', `${formatDateTime(journal.postedAt)} · ${journal.postedBy ?? ''}`]] as [string, string][]) : []),
            ]}
          />
          <p className="text-sm">{journal.description}</p>
          {journal.reversalOf && (
            <Alert>
              This entry reverses{' '}
              <Link to={`/accounting/journals/${journal.reversalOf.id}`} className="font-mono underline">
                {journal.reversalOf.number}
              </Link>
              .
            </Alert>
          )}
          {journal.reversedBy && (
            <Alert>
              Reversed by{' '}
              <Link to={`/accounting/journals/${journal.reversedBy.id}`} className="font-mono underline">
                {journal.reversedBy.number}
              </Link>
              .
            </Alert>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="hidden md:table-cell">Memo</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {journal.lines.map((l) => (
                <TableRow key={l.lineNo}>
                  <TableCell>
                    <Link to={`/accounting/ledger?accountId=${l.account.id}`} className="hover:underline">
                      <span className="font-mono">{l.account.code}</span> {l.account.name}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{[l.memo, l.location].filter(Boolean).join(' · ') || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell colSpan={2}>Total</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(journal.totalDebit)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(journal.totalCredit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2">
        {isDraft && isManual && can('journals.post') && (
          <ConfirmAction title="Post this journal?" description="Posting numbers the entry and updates the ledger. It cannot be edited afterwards, only reversed." confirmLabel="Post" onConfirm={post}>
            Post
          </ConfirmAction>
        )}
        {isDraft && isManual && can('journals.create') && (
          <>
            <Button variant="outline" onClick={onEdit}>
              Edit
            </Button>
            <ConfirmAction variant="outline" title="Delete this draft?" description="The draft is removed. Nothing was posted." confirmLabel="Delete" destructive onConfirm={remove}>
              Delete
            </ConfirmAction>
          </>
        )}
        {journal.reversible && can('journals.reverse') && (
          <Button variant="outline" onClick={() => setReversing(true)}>
            Reverse
          </Button>
        )}
      </div>
      {!isManual && journal.status === 'POSTED' && !journal.reversible && sourcePath && (
        <p className="text-xs text-muted-foreground">Entries made by documents are corrected through the document itself (a return, a credit or a new payment), so the ledger and the document always agree.</p>
      )}
      {reversing && (
        <ReverseDialog
          journal={journal}
          open={reversing}
          onOpenChange={setReversing}
          onDone={(reversal) => {
            toast.success(`Reversal ${reversal.number} posted`);
            setReversing(false);
            onChanged(reversal);
            navigate(`/accounting/journals/${reversal.id}`);
          }}
        />
      )}
    </div>
  );
}

export function JournalPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const refresh = useRefreshLedger();
  const [editing, setEditing] = useState(false);
  const journal = useQuery({
    queryKey: ['journals', 'detail', id],
    queryFn: ({ signal }) => api.get<DataEnvelope<JournalDetail>>(`/accounting/journals/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
  const title = id ? (journal.data ? (journal.data.number ? `Journal ${journal.data.number}` : 'Draft journal') : 'Journal') : 'New journal';

  return (
    <DocumentShell back={{ to: '/accounting/journals', label: 'Journals' }} title={title} isNew={!id} query={journal}>
      {!id && (
        <JournalEditor
          onSaved={(j) => {
            void refresh();
            navigate(`/accounting/journals/${j.id}`, { replace: true });
          }}
        />
      )}
      {journal.data &&
        (editing ? (
          <JournalEditor
            existing={journal.data}
            onSaved={() => {
              setEditing(false);
              void refresh();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <JournalView journal={journal.data} onEdit={() => setEditing(true)} onChanged={() => void refresh()} />
        ))}
    </DocumentShell>
  );
}
