import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import type { z } from 'zod';
import { paymentMethodInputSchema, registerInputSchema, type DataEnvelope, type PaymentMethodSummary, type RegisterSummary } from '@rhoyards/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { api } from '../../lib/api';
import { applyServerErrors } from '../../lib/forms';
import { useAccountOptions } from '../purchasing/api';
import { useLocations } from '../users/api';

const KIND_LABEL: Record<PaymentMethodSummary['kind'], string> = { CASH: 'Cash', CARD: 'Card / POS terminal', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other' };

// ── Payment methods ──────────────────────────────────────────────────────

type MethodValues = z.input<typeof paymentMethodInputSchema>;

function PaymentMethodForm({ method, onDone }: { method?: PaymentMethodSummary | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const accounts = useAccountOptions('payment');
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<MethodValues>({
    resolver: zodResolver(paymentMethodInputSchema),
    defaultValues: method
      ? { ...method, accountId: method.account.id }
      : { code: '', name: '', kind: 'CARD', accountId: '', requiresReference: false, availablePos: true, availableOnline: false, isActive: true, sortOrder: 0 },
  });
  const e = formState.errors;
  const mutation = useMutation({
    mutationFn: ({ code, ...rest }: MethodValues) => (method ? api.patch(`/payment-methods/${method.id}`, rest) : api.post('/payment-methods', { code, ...rest })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      void queryClient.invalidateQueries({ queryKey: ['pos-context'] });
      toast.success(method ? 'Payment method saved' : 'Payment method added');
      onDone();
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, ['code', 'name', 'kind', 'accountId', 'sortOrder'])),
  });
  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pm-name" label="Name" error={e.name?.message}>
          <Input {...register('name')} />
        </Field>
        <Field id="pm-code" label="Code" error={e.code?.message}>
          <Input disabled={Boolean(method)} className="uppercase" {...register('code')} />
        </Field>
        <Field id="pm-kind" label="Kind" description="Only cash counts towards the drawer." error={e.kind?.message}>
          <Select {...register('kind')}>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="pm-account" label="Paid into (ledger account)" error={e.accountId?.message ?? accounts.error?.message}>
          <Select {...register('accountId')}>
            <option value="">Choose…</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="pm-sort" label="Display order" error={e.sortOrder?.message}>
          <Input type="number" min={0} className="w-24" {...register('sortOrder', { valueAsNumber: true })} />
        </Field>
      </div>
      <div className="grid gap-2 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox {...register('requiresReference')} /> Require a reference (e.g. transfer ID)
        </label>
        <label className="flex items-center gap-2">
          <Checkbox {...register('availablePos')} /> Available at the till
        </label>
        <label className="flex items-center gap-2">
          <Checkbox {...register('availableOnline')} /> Available for online orders
        </label>
        <label className="flex items-center gap-2">
          <Checkbox {...register('isActive')} /> Active
        </label>
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

export function PaymentMethodsCard() {
  const { can } = useAuth();
  const canManage = can('settings.manage');
  const methods = useQuery({
    queryKey: ['payment-methods'],
    queryFn: ({ signal }) => api.get<DataEnvelope<PaymentMethodSummary[]>>('/payment-methods', { signal }).then((r) => r.data),
  });
  const [dialog, setDialog] = useState<{ open: boolean; method?: PaymentMethodSummary }>({ open: false });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Payment methods</CardTitle>
          <CardDescription>How customers can pay, and which account each payment is recorded in.</CardDescription>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setDialog({ open: true })}>
            <Plus />
            Add
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {methods.isError && <Alert variant="destructive">{methods.error.message}</Alert>}
        <ul className="divide-y">
          {methods.data?.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <div className="font-medium">
                  {m.name} <span className="font-mono text-xs text-muted-foreground">{m.code}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <Badge variant="secondary">{KIND_LABEL[m.kind]}</Badge>
                  <span>
                    → {m.account.code} {m.account.name}
                  </span>
                  {m.availablePos && <Badge variant="outline">Till</Badge>}
                  {m.availableOnline && <Badge variant="outline">Online</Badge>}
                  {!m.isActive && <Badge variant="destructive">Inactive</Badge>}
                </div>
              </div>
              {canManage && (
                <Button variant="ghost" size="icon" aria-label={`Edit ${m.name}`} onClick={() => setDialog({ open: true, method: m })}>
                  <Pencil />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog.method ? `Edit ${dialog.method.name}` : 'New payment method'}</DialogTitle>
          </DialogHeader>
          {dialog.open && <PaymentMethodForm key={dialog.method?.id ?? 'new'} method={dialog.method} onDone={() => setDialog({ open: false })} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Registers (tills) ────────────────────────────────────────────────────

type RegisterValues = z.input<typeof registerInputSchema>;

function RegisterForm({ register: till, onDone }: { register?: RegisterSummary | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const locations = useLocations();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<RegisterValues>({
    resolver: zodResolver(registerInputSchema),
    defaultValues: till ? { locationId: till.location.id, name: till.name, isActive: till.isActive } : { locationId: '', name: '', isActive: true },
  });
  const mutation = useMutation({
    mutationFn: ({ locationId, ...rest }: RegisterValues) => (till ? api.patch(`/registers/${till.id}`, rest) : api.post('/registers', { locationId, ...rest })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['registers'] });
      void queryClient.invalidateQueries({ queryKey: ['pos-context'] });
      toast.success(till ? 'Till saved' : 'Till added');
      onDone();
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, ['locationId', 'name'])),
  });
  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="reg-location" label="Location" error={formState.errors.locationId?.message}>
        <Select disabled={Boolean(till)} {...register('locationId')}>
          <option value="">Choose…</option>
          {locations.data
            ?.filter((l) => l.isPosEnabled || l.id === till?.location.id)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field id="reg-name" label="Name" error={formState.errors.name?.message}>
        <Input {...register('name')} />
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

export function RegistersCard() {
  const { can } = useAuth();
  const canManage = can('locations.manage');
  const registers = useQuery({
    queryKey: ['registers'],
    queryFn: ({ signal }) => api.get<DataEnvelope<RegisterSummary[]>>('/registers', { signal }).then((r) => r.data),
  });
  const [dialog, setDialog] = useState<{ open: boolean; register?: RegisterSummary }>({ open: false });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Tills</CardTitle>
          <CardDescription>Cash registers at point-of-sale locations. One cashier shift can be open per till.</CardDescription>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setDialog({ open: true })}>
            <Plus />
            Add
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {registers.isError && <Alert variant="destructive">{registers.error.message}</Alert>}
        <ul className="divide-y">
          {registers.data?.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <div className="font-medium">{r.name}</div>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <span>{r.location.name}</span>
                  {r.openShift && <Badge variant="outline">In use: {r.openShift.cashier}</Badge>}
                  {!r.isActive && <Badge variant="destructive">Inactive</Badge>}
                </div>
              </div>
              {canManage && (
                <Button variant="ghost" size="icon" aria-label={`Edit ${r.name}`} onClick={() => setDialog({ open: true, register: r })}>
                  <Pencil />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog.register ? `Edit ${dialog.register.name}` : 'New till'}</DialogTitle>
          </DialogHeader>
          {dialog.open && <RegisterForm key={dialog.register?.id ?? 'new'} register={dialog.register} onDone={() => setDialog({ open: false })} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
