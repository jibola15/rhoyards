import { useState } from 'react';
import { Link } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Plus } from 'lucide-react';
import { z } from 'zod';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, subtypeMatchesType, type AccountRow, type AccountTypeCode } from '@rhoyards/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogContent,
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
  Textarea,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { PageHeader, QueryError } from '../../components/page';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { TYPE_LABELS, useAccounts } from './api';

const schema = z
  .object({
    code: z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/, 'Use up to 20 letters, digits, dots or dashes'),
    name: z.string().trim().min(1, 'Enter a name').max(120),
    type: z.enum(ACCOUNT_TYPES),
    subtype: z.string().min(1, 'Choose a classification'),
    description: z.string().max(500),
    parentId: z.string(),
    isPostable: z.boolean(),
    isActive: z.boolean(),
  })
  .refine((v) => subtypeMatchesType(v.type, v.subtype), { message: 'Choose a classification for this type', path: ['subtype'] });
type Values = z.infer<typeof schema>;
const FIELDS = ['code', 'name', 'type', 'subtype', 'description', 'parentId'];

function AccountForm({ account, accounts, onDone }: { account?: AccountRow | undefined; accounts: AccountRow[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const locked = Boolean(account?.systemKey);
  const typeFixed = locked || Boolean(account?.hasEntries);
  const { register, handleSubmit, setError, setValue, formState, control } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: account?.code ?? '',
      name: account?.name ?? '',
      type: account?.type ?? 'EXPENSE',
      subtype: account?.subtype ?? 'OPERATING_EXPENSE',
      description: account?.description ?? '',
      parentId: account?.parentId ?? '',
      isPostable: account?.isPostable ?? true,
      isActive: account?.isActive ?? true,
    },
  });
  const type = useWatch({ control, name: 'type' });
  const parents = accounts.filter((a) => a.type === type && a.id !== account?.id);
  const e = formState.errors;

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const body = { ...v, parentId: v.parentId || null, description: v.description || null };
      if (!account) {
        const { isActive: _ignored, ...create } = body;
        return api.post('/accounting/accounts', create);
      }
      return api.patch(`/accounting/accounts/${account.id}`, typeFixed ? { ...body, type: undefined } : body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(account ? 'Account saved' : 'Account added');
      onDone();
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, FIELDS)),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      {locked && <Alert>This is a system account used by automatic postings. You can rename it, but not change its type or switch it off.</Alert>}
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field id="a-code" label="Code" error={e.code?.message}>
          <Input {...register('code')} />
        </Field>
        <Field id="a-name" label="Name" error={e.name?.message}>
          <Input {...register('name')} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="a-type" label="Type" error={e.type?.message} description={typeFixed && !locked ? 'Fixed: the account has postings.' : undefined}>
          {typeFixed ? (
            <Input value={TYPE_LABELS[type]} readOnly />
          ) : (
            <Select
              {...register('type', {
                onChange: (ev: { target: { value: AccountTypeCode } }) => setValue('subtype', Object.keys(ACCOUNT_SUBTYPES[ev.target.value])[0]!),
              })}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="a-subtype" label="Shown in reports as" error={e.subtype?.message}>
          <Select {...register('subtype')}>
            {Object.entries(ACCOUNT_SUBTYPES[type]).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="a-parent" label="Group under" className="sm:col-span-2">
          <Select {...register('parentId')}>
            <option value="">— None —</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field id="a-desc" label="Description" error={e.description?.message}>
        <Textarea rows={2} {...register('description')} />
      </Field>
      <div className="flex flex-wrap gap-6">
        {locked || account?.hasEntries ? (
          <p className="text-sm text-muted-foreground">Takes postings{locked ? '' : ' (it already has some, so this cannot change)'}.</p>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox {...register('isPostable')} /> Takes postings (untick for a heading account)
          </label>
        )}
        {account && !locked && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox {...register('isActive')} /> Active
          </label>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AccountsPage() {
  const { can } = useAuth();
  const accounts = useAccounts();
  const [showInactive, setShowInactive] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; account?: AccountRow }>({ open: false });
  const canManage = can('accounts.manage');
  const rows = (accounts.data ?? []).filter((a) => showInactive || a.isActive);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chart of accounts"
        description="Every account in the general ledger with its posted balance. Locked accounts are kept by their own ledgers (customers, suppliers, stock)."
        actions={
          canManage && (
            <Button onClick={() => setDialog({ open: true })}>
              <Plus />
              New account
            </Button>
          )
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive accounts
          </label>
          {accounts.isError && <QueryError error={accounts.error} onRetry={() => void accounts.refetch()} />}
          {accounts.isPending && <Skeleton className="h-64 w-full" />}
          {accounts.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Code</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="hidden md:table-cell">Shown as</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  {canManage && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {ACCOUNT_TYPES.map((type) => {
                  const group = rows.filter((a) => a.type === type);
                  if (group.length === 0) return null;
                  return [
                    <TableRow key={type} className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={canManage ? 5 : 4} className="font-semibold">
                        {TYPE_LABELS[type]}
                      </TableCell>
                    </TableRow>,
                    ...group.map((a) => (
                      <TableRow key={a.id} className={a.isActive ? '' : 'text-muted-foreground'}>
                        <TableCell className="font-mono">{a.code}</TableCell>
                        <TableCell>
                          <Link to={`/accounting/ledger?accountId=${a.id}`} className={`hover:underline ${a.parentId ? 'pl-4' : ''} ${a.isPostable ? '' : 'font-semibold'}`}>
                            {a.name}
                          </Link>
                          {a.isControl && <Lock className="ml-1.5 inline size-3.5 text-muted-foreground" aria-label="Kept by its own ledger" />}
                          {!a.isActive && (
                            <Badge variant="secondary" className="ml-2">
                              Inactive
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {a.subtype ? (ACCOUNT_SUBTYPES[a.type] as Record<string, string>)[a.subtype] ?? a.subtype : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{a.balance === '0.00' ? '—' : formatMoney(a.balance)}</TableCell>
                        {canManage && (
                          <TableCell>
                            <Button variant="ghost" size="icon" aria-label={`Edit ${a.name}`} onClick={() => setDialog({ open: true, account: a })}>
                              <Pencil />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    )),
                  ];
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialog.account ? `Edit ${dialog.account.code} ${dialog.account.name}` : 'New account'}</DialogTitle>
          </DialogHeader>
          {dialog.open && accounts.data && (
            <AccountForm key={dialog.account?.id ?? 'new'} account={dialog.account} accounts={accounts.data} onDone={() => setDialog({ open: false })} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
