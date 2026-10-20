import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import type { z } from 'zod';
import { locationInputSchema, type LocationSummary } from '@rhoyards/shared';
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
import { useLocations } from '../users/api';

type Values = z.input<typeof locationInputSchema>;

function LocationForm({ location, onDone }: { location?: LocationSummary | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(locationInputSchema),
    defaultValues: location
      ? { ...location, address: location.address ?? '', phone: location.phone ?? '' }
      : {
          code: '',
          name: '',
          type: 'STORE',
          isPosEnabled: false,
          isOnlineFulfilment: false,
          address: '',
          phone: '',
          isActive: true,
        },
  });

  const mutation = useMutation({
    mutationFn: ({ code, ...rest }: Values) =>
      location ? api.patch(`/locations/${location.id}`, rest) : api.post('/locations', { code, ...rest }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['locations'] });
      toast.success(location ? 'Location updated' : 'Location created');
      onDone();
    },
    onError: (e) =>
      setFormError(applyServerErrors(e, setError, ['code', 'name', 'type', 'address', 'phone'])),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="loc-name" label="Name" error={formState.errors.name?.message}>
          <Input {...register('name')} />
        </Field>
        <Field id="loc-code" label="Code" error={formState.errors.code?.message}>
          <Input disabled={Boolean(location)} {...register('code')} />
        </Field>
      </div>
      <Field id="loc-type" label="Type">
        <Select {...register('type')}>
          <option value="STORE">Store</option>
          <option value="WAREHOUSE">Warehouse</option>
        </Select>
      </Field>
      <Field id="loc-address" label="Address" error={formState.errors.address?.message}>
        <Input {...register('address')} />
      </Field>
      <Field id="loc-phone" label="Phone" error={formState.errors.phone?.message}>
        <Input type="tel" {...register('phone')} />
      </Field>
      <div className="grid gap-2 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox {...register('isPosEnabled')} /> Point of sale runs here
        </label>
        <label className="flex items-center gap-2">
          <Checkbox {...register('isOnlineFulfilment')} /> Fulfils online orders (one store at a time: the online shop sells its stock)
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

function LocationDialog({
  location,
  open,
  onOpenChange,
}: {
  location?: LocationSummary;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{location ? `Edit ${location.name}` : 'New location'}</DialogTitle>
        </DialogHeader>
        <LocationForm location={location} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

export function LocationsCard() {
  const { can } = useAuth();
  const canManage = can('locations.manage');
  const locations = useLocations();
  const [editing, setEditing] = useState<LocationSummary | undefined>();
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Locations</CardTitle>
          <CardDescription>Stores and warehouses that hold stock.</CardDescription>
        </div>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(undefined);
              setOpen(true);
            }}
          >
            <Plus />
            Add
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {locations.isError && <Alert variant="destructive">{locations.error.message}</Alert>}
        <ul className="divide-y">
          {locations.data?.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <div className="font-medium">
                  {l.name} <span className="font-mono text-xs text-muted-foreground">{l.code}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="secondary">{l.type === 'STORE' ? 'Store' : 'Warehouse'}</Badge>
                  {l.isPosEnabled && <Badge variant="outline">POS</Badge>}
                  {l.isOnlineFulfilment && <Badge variant="outline">Online orders</Badge>}
                  {!l.isActive && <Badge variant="destructive">Inactive</Badge>}
                </div>
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${l.name}`}
                  onClick={() => {
                    setEditing(l);
                    setOpen(true);
                  }}
                >
                  <Pencil />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <LocationDialog open={open} onOpenChange={setOpen} {...(editing ? { location: editing } : {})} />
    </Card>
  );
}
