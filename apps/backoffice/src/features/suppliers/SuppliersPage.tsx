import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search } from 'lucide-react';
import { z } from 'zod';
import type { ListEnvelope, SupplierSummary } from '@rhoyards/shared';
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
import { applyServerErrors } from '../../lib/forms';
import { useDebouncedValue } from '../../lib/use-debounced-value';

const PAGE_SIZE = 25;
const schema = z.object({
  code: z.string().trim().max(20),
  name: z.string().trim().min(1, 'Name is required').max(160),
  contactName: z.string().max(120),
  email: z.union([z.literal(''), z.email('Enter a valid email address')]),
  phone: z.string().max(40),
  address: z.string().max(500),
  taxId: z.string().max(40),
  paymentTermsDays: z.number({ error: 'Enter a number of days' }).int().min(0).max(365),
  notes: z.string().max(2000),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;
const FIELDS = ['code', 'name', 'contactName', 'email', 'phone', 'address', 'taxId', 'paymentTermsDays', 'notes'];

function SupplierForm({ supplier, onDone }: { supplier?: SupplierSummary | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: supplier?.code ?? '',
      name: supplier?.name ?? '',
      contactName: supplier?.contactName ?? '',
      email: supplier?.email ?? '',
      phone: supplier?.phone ?? '',
      address: supplier?.address ?? '',
      taxId: supplier?.taxId ?? '',
      paymentTermsDays: supplier?.paymentTermsDays ?? 0,
      notes: supplier?.notes ?? '',
      isActive: supplier?.isActive ?? true,
    },
  });
  const e = formState.errors;
  const mutation = useMutation({
    mutationFn: ({ code, ...rest }: Values) => (supplier ? api.patch(`/suppliers/${supplier.id}`, rest) : api.post('/suppliers', { code, ...rest })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      toast.success(supplier ? 'Supplier saved' : 'Supplier created');
      onDone();
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, FIELDS)),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="s-name" label="Name" error={e.name?.message} className="sm:col-span-2">
          <Input {...register('name')} />
        </Field>
        <Field id="s-code" label="Code" description={supplier ? undefined : 'Leave blank to generate one.'} error={e.code?.message}>
          <Input disabled={Boolean(supplier)} className="uppercase" {...register('code')} />
        </Field>
        <Field id="s-terms" label="Payment terms (days)" error={e.paymentTermsDays?.message}>
          <Input type="number" min={0} max={365} {...register('paymentTermsDays', { valueAsNumber: true })} />
        </Field>
        <Field id="s-contact" label="Contact person" error={e.contactName?.message}>
          <Input {...register('contactName')} />
        </Field>
        <Field id="s-phone" label="Phone" error={e.phone?.message}>
          <Input type="tel" {...register('phone')} />
        </Field>
        <Field id="s-email" label="Email" error={e.email?.message}>
          <Input type="email" {...register('email')} />
        </Field>
        <Field id="s-tax" label="Tax ID (TIN)" error={e.taxId?.message}>
          <Input {...register('taxId')} />
        </Field>
        <Field id="s-address" label="Address" error={e.address?.message} className="sm:col-span-2">
          <Textarea rows={2} {...register('address')} />
        </Field>
        <Field id="s-notes" label="Notes" error={e.notes?.message} className="sm:col-span-2">
          <Textarea rows={2} {...register('notes')} />
        </Field>
      </div>
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

export function SuppliersPage() {
  const { can } = useAuth();
  const canManage = can('suppliers.manage');
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ open: boolean; supplier?: SupplierSummary }>({ open: false });
  const q = useDebouncedValue(search.trim());
  const suppliers = useQuery({
    queryKey: ['suppliers', { q, includeInactive, page }],
    queryFn: ({ signal }) =>
      api.get<ListEnvelope<SupplierSummary>>(`/suppliers${qs({ q, includeInactive: includeInactive ? 'true' : undefined, page, pageSize: PAGE_SIZE })}`, { signal }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description="Who you buy stock from. Suppliers are deactivated rather than deleted."
        actions={
          canManage && (
            <Button onClick={() => setDialog({ open: true })}>
              <Plus />
              New supplier
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
                aria-label="Search suppliers"
                placeholder="Name, code, contact or phone"
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
          {suppliers.isError ? (
            <QueryError error={suppliers.error} onRetry={() => void suppliers.refetch()} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="hidden md:table-cell">Contact</TableHead>
                    <TableHead className="text-right">Terms</TableHead>
                    {canManage && (
                      <TableHead className="w-12">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suppliers.isPending && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {suppliers.data?.data.map((s) => (
                    <TableRow key={s.id} className={s.isActive ? undefined : 'opacity-60'}>
                      <TableCell>
                        <div className="font-medium">
                          <Link to={`/suppliers/${s.id}`} className="hover:underline">
                            {s.name}
                          </Link>{' '}
                          {!s.isActive && <Badge variant="outline">Inactive</Badge>}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">{s.code}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div>{s.contactName ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">{[s.phone, s.email].filter(Boolean).join(' · ')}</div>
                      </TableCell>
                      <TableCell className="text-right">{s.paymentTermsDays === 0 ? 'On delivery' : `${s.paymentTermsDays} days`}</TableCell>
                      {canManage && (
                        <TableCell>
                          <Button variant="ghost" size="icon" aria-label={`Edit ${s.name}`} onClick={() => setDialog({ open: true, supplier: s })}>
                            <Pencil />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {suppliers.data?.data.length === 0 && <EmptyState title={q ? 'No suppliers match your search' : 'No suppliers yet'} />}
              {suppliers.data && suppliers.data.meta.total > 0 && (
                <Pagination page={page} pageSize={PAGE_SIZE} total={suppliers.data.meta.total} onPageChange={setPage} />
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialog.supplier ? `Edit ${dialog.supplier.name}` : 'New supplier'}</DialogTitle>
          </DialogHeader>
          <SupplierForm supplier={dialog.supplier} onDone={() => setDialog({ open: false })} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
