import { useState } from 'react';
import { Link } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search } from 'lucide-react';
import { z } from 'zod';
import type { CustomerSummary, ListEnvelope } from '@rhoyards/shared';
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
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { api, qs } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { useDebouncedValue } from '../../lib/use-debounced-value';

const PAGE_SIZE = 25;
const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160),
  type: z.enum(['RETAIL', 'WHOLESALE']),
  phone: z.string().max(40),
  email: z.union([z.literal(''), z.email('Enter a valid email address')]),
  address: z.string().max(500),
  allowCredit: z.boolean(),
  creditLimit: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount'),
  notes: z.string().max(2000),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;
const FIELDS = ['name', 'type', 'phone', 'email', 'address', 'creditLimit', 'notes'];

function CustomerForm({ customer, onDone }: { customer?: CustomerSummary | undefined; onDone: () => void }) {
  const { can } = useAuth();
  const canCredit = can('pos.credit_sale');
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState, control } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: customer?.name ?? '',
      type: customer?.type ?? 'RETAIL',
      phone: customer?.phone ?? '',
      email: customer?.email ?? '',
      address: customer?.address ?? '',
      allowCredit: customer?.allowCredit ?? false,
      creditLimit: customer?.creditLimit ?? '0',
      notes: customer?.notes ?? '',
      isActive: customer?.isActive ?? true,
    },
  });
  const e = formState.errors;
  const allowCredit = useWatch({ control, name: 'allowCredit' });
  const mutation = useMutation({
    mutationFn: ({ allowCredit, creditLimit, ...rest }: Values) => {
      // Credit terms are only sent by users who may grant credit; the API enforces this too.
      const body = canCredit ? { ...rest, allowCredit, creditLimit } : rest;
      return customer ? api.patch(`/customers/${customer.id}`, body) : api.post('/customers', body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast.success(customer ? 'Customer saved' : 'Customer added');
      onDone();
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, FIELDS)),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="c-name" label="Name" error={e.name?.message} className="sm:col-span-2">
          <Input {...register('name')} />
        </Field>
        <Field id="c-type" label="Type">
          <Select {...register('type')}>
            <option value="RETAIL">Retail</option>
            <option value="WHOLESALE">Wholesale / salon</option>
          </Select>
        </Field>
        <Field id="c-phone" label="Phone" error={e.phone?.message}>
          <Input type="tel" {...register('phone')} />
        </Field>
        <Field id="c-email" label="Email" error={e.email?.message} className="sm:col-span-2">
          <Input type="email" {...register('email')} />
        </Field>
        <Field id="c-address" label="Address" error={e.address?.message} className="sm:col-span-2">
          <Textarea rows={2} {...register('address')} />
        </Field>
      </div>
      <fieldset disabled={!canCredit} className="grid gap-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Credit account</legend>
        {!canCredit && <p className="text-xs text-muted-foreground">Only staff who may sell on credit can change credit terms.</p>}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox {...register('allowCredit')} /> Allow sales on credit
        </label>
        {allowCredit && (
          <Field id="c-limit" label="Credit limit (₦)" description="0 means no limit." error={e.creditLimit?.message}>
            <Input inputMode="decimal" className="w-40" {...register('creditLimit')} />
          </Field>
        )}
      </fieldset>
      <Field id="c-notes" label="Notes" error={e.notes?.message}>
        <Textarea rows={2} {...register('notes')} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox {...register('isActive')} /> Active
      </label>
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

export function CustomersPage() {
  const { can } = useAuth();
  const canManage = can('customers.manage');
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ open: boolean; customer?: CustomerSummary }>({ open: false });
  const q = useDebouncedValue(search.trim());
  const customers = useQuery({
    queryKey: ['customers', { q, includeInactive, page }],
    queryFn: ({ signal }) =>
      api.get<ListEnvelope<CustomerSummary>>(`/customers${qs({ q, includeInactive: includeInactive ? 'true' : undefined, page, pageSize: PAGE_SIZE })}`, { signal }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Regular and wholesale customers. Balances are what they owe on credit sales."
        actions={
          canManage && (
            <Button onClick={() => setDialog({ open: true })}>
              <Plus />
              New customer
            </Button>
          )
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                aria-label="Search customers"
                placeholder="Name, code, phone or email"
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include inactive
            </label>
          </div>
          {customers.isError ? (
            <QueryError error={customers.error} onRetry={() => void customers.refetch()} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="hidden md:table-cell">Contact</TableHead>
                    <TableHead className="text-right">Credit limit</TableHead>
                    <TableHead className="text-right">Owes</TableHead>
                    {canManage && (
                      <TableHead className="w-12">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers.isPending && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {customers.data?.data.map((c) => (
                    <TableRow key={c.id} className={c.isActive ? undefined : 'opacity-60'}>
                      <TableCell>
                        <div className="font-medium">
                          <Link to={`/customers/${c.id}`} className="hover:underline" title="Account and payments">
                            {c.name}
                          </Link>{' '}
                          {c.type === 'WHOLESALE' && <Badge variant="secondary">Wholesale</Badge>} {!c.isActive && <Badge variant="outline">Inactive</Badge>}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">{c.code}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</TableCell>
                      <TableCell className="text-right">{c.allowCredit ? (Number(c.creditLimit) > 0 ? formatMoney(c.creditLimit) : 'No limit') : 'No credit'}</TableCell>
                      <TableCell className="text-right font-medium">{Number(c.balance) > 0 ? formatMoney(c.balance) : Number(c.balance) < 0 ? `${formatMoney(c.balance.slice(1))} credit` : '—'}</TableCell>
                      {canManage && (
                        <TableCell>
                          <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => setDialog({ open: true, customer: c })}>
                            <Pencil />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {customers.data?.data.length === 0 && <EmptyState title={q ? 'No customers match your search' : 'No customers yet'} />}
              {customers.data && customers.data.meta.total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={customers.data.meta.total} onPageChange={setPage} />}
            </>
          )}
        </CardContent>
      </Card>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialog.customer ? `Edit ${dialog.customer.name}` : 'New customer'}</DialogTitle>
          </DialogHeader>
          {dialog.open && <CustomerForm key={dialog.customer?.id ?? 'new'} customer={dialog.customer} onDone={() => setDialog({ open: false })} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
