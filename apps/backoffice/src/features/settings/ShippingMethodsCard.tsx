import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import type { z } from 'zod';
import { NIGERIAN_STATES, shippingMethodInputSchema, type DataEnvelope, type ShippingMethodRow } from '@rhoyards/shared';
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
  Textarea,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';

type Values = z.input<typeof shippingMethodInputSchema>;

function ShippingForm({ method, onDone }: { method?: ShippingMethodRow | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState, control, setValue } = useForm<Values>({
    resolver: zodResolver(shippingMethodInputSchema),
    defaultValues: method
      ? { ...method, description: method.description ?? '', freeOver: method.freeOver ?? '', states: method.states as Values['states'] }
      : { name: '', description: '', fee: '0', freeOver: '', states: [], isPickup: false, isActive: true, sortOrder: 0 },
  });
  const isPickup = useWatch({ control, name: 'isPickup' });
  const states = useWatch({ control, name: 'states' }) ?? [];
  const e = formState.errors;
  const mutation = useMutation({
    mutationFn: (v: Values) => (method ? api.patch(`/shipping-methods/${method.id}`, v) : api.post('/shipping-methods', v)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['shipping-methods'] });
      toast.success(method ? 'Delivery option saved' : 'Delivery option added');
      onDone();
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, ['name', 'description', 'fee', 'freeOver', 'sortOrder'])),
  });
  const toggleState = (s: (typeof NIGERIAN_STATES)[number]) =>
    setValue('states', states.includes(s) ? states.filter((x) => x !== s) : [...states, s], { shouldDirty: true });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="sm-name" label="Name" error={e.name?.message} className="sm:col-span-2">
          <Input {...register('name')} />
        </Field>
        <Field id="sm-desc" label="Description for customers" className="sm:col-span-2">
          <Textarea rows={2} {...register('description')} />
        </Field>
        <Field id="sm-fee" label="Fee (₦)" description="Charged like product prices (VAT included or added)." error={e.fee?.message}>
          <Input inputMode="decimal" {...register('fee')} />
        </Field>
        <Field id="sm-free" label="Free when items total at least (₦)" description="Leave blank for never." error={e.freeOver?.message}>
          <Input inputMode="decimal" {...register('freeOver')} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox {...register('isPickup')} /> Collection from the store (no address)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox {...register('isActive')} /> Offered to customers
        </label>
      </div>
      {!isPickup && (
        <fieldset className="grid gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Delivers to {states.length === 0 ? 'every state' : `${states.length} state${states.length === 1 ? '' : 's'}`}</legend>
          <p className="text-xs text-muted-foreground">Tick none to deliver everywhere.</p>
          <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3">
            {NIGERIAN_STATES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <Checkbox checked={states.includes(s)} onChange={() => toggleState(s)} /> {s}
              </label>
            ))}
          </div>
        </fieldset>
      )}
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

export function ShippingMethodsCard() {
  const { can } = useAuth();
  const canManage = can('settings.manage');
  const [dialog, setDialog] = useState<{ open: boolean; method?: ShippingMethodRow }>({ open: false });
  const methods = useQuery({
    queryKey: ['shipping-methods'],
    queryFn: ({ signal }) => api.get<DataEnvelope<ShippingMethodRow[]>>('/shipping-methods', { signal }).then((r) => r.data),
  });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Delivery options</CardTitle>
          <CardDescription>What online customers can choose at checkout. Delivery income is posted to Shipping income.</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setDialog({ open: true })}>
            <Plus />
            Add
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {methods.isError && <Alert variant="destructive">{methods.error.message}</Alert>}
        <ul className="divide-y text-sm">
          {methods.data?.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <span className="font-medium">{m.name}</span>
                {!m.isActive && (
                  <Badge variant="secondary" className="ml-2">
                    Off
                  </Badge>
                )}
                <div className="text-xs text-muted-foreground">
                  {m.isPickup ? 'Collection' : m.states.length === 0 ? 'Everywhere' : m.states.join(', ')}
                  {m.freeOver ? ` · free over ${formatMoney(m.freeOver)}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular-nums">{m.fee === '0.00' ? 'Free' : formatMoney(m.fee)}</span>
                {canManage && (
                  <Button variant="ghost" size="icon" aria-label={`Edit ${m.name}`} onClick={() => setDialog({ open: true, method: m })}>
                    <Pencil />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialog.method ? `Edit ${dialog.method.name}` : 'New delivery option'}</DialogTitle>
          </DialogHeader>
          {dialog.open && <ShippingForm key={dialog.method?.id ?? 'new'} method={dialog.method} onDone={() => setDialog({ open: false })} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
