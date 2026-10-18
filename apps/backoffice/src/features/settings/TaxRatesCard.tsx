import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import type { z } from 'zod';
import { taxRateInputSchema, type DataEnvelope, type TaxRateSummary } from '@rhoyards/shared';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { api } from '../../lib/api';
import { applyServerErrors } from '../../lib/forms';

const KIND_LABEL = { STANDARD: 'Standard', ZERO_RATED: 'Zero-rated', EXEMPT: 'Exempt' } as const;
type Values = z.input<typeof taxRateInputSchema>;

function TaxRateForm({ rate, onDone }: { rate?: TaxRateSummary | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(taxRateInputSchema),
    defaultValues: rate
      ? {
          code: rate.code,
          name: rate.name,
          kind: rate.kind,
          rate: String(Number(rate.rate)),
          isActive: rate.isActive,
        }
      : { code: '', name: '', kind: 'STANDARD', rate: '', isActive: true },
  });

  const mutation = useMutation({
    mutationFn: (v: Values) =>
      rate
        ? api.patch(`/tax-rates/${rate.id}`, { name: v.name, rate: v.rate, isActive: v.isActive })
        : api.post('/tax-rates', v),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tax-rates'] });
      toast.success(rate ? 'Tax rate updated (applies to new transactions)' : 'Tax rate created');
      onDone();
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['code', 'name', 'kind', 'rate'])),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="tax-name" label="Name" error={formState.errors.name?.message}>
        <Input {...register('name')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="tax-code" label="Code" error={formState.errors.code?.message}>
          <Input disabled={Boolean(rate)} {...register('code')} />
        </Field>
        <Field id="tax-kind" label="Type" error={formState.errors.kind?.message}>
          <Select disabled={Boolean(rate)} {...register('kind')}>
            <option value="STANDARD">Standard</option>
            <option value="ZERO_RATED">Zero-rated</option>
            <option value="EXEMPT">Exempt</option>
          </Select>
        </Field>
      </div>
      <Field id="tax-rate" label="Rate (%)" error={formState.errors.rate?.message}>
        <Input inputMode="decimal" className="w-32" {...register('rate')} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox {...register('isActive')} />
        Active
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

function TaxRateDialog({
  rate,
  open,
  onOpenChange,
}: {
  rate?: TaxRateSummary;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rate ? `Edit ${rate.name}` : 'New tax rate'}</DialogTitle>
        </DialogHeader>
        <TaxRateForm rate={rate} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

export function TaxRatesCard() {
  const { can } = useAuth();
  const canManage = can('taxes.manage');
  const rates = useQuery({
    queryKey: ['tax-rates'],
    queryFn: ({ signal }) =>
      api.get<DataEnvelope<TaxRateSummary[]>>('/tax-rates', { signal }).then((r) => r.data),
  });
  const [editing, setEditing] = useState<TaxRateSummary | undefined>();
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Tax rates</CardTitle>
          <CardDescription>
            Assigned to products. Sales record the rate used at the time of sale.
          </CardDescription>
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
        {rates.isError && <Alert variant="destructive">{rates.error.message}</Alert>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              {canManage && (
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.data?.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {r.name} {!r.isActive && <Badge variant="outline">Inactive</Badge>}
                </TableCell>
                <TableCell>{KIND_LABEL[r.kind]}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(r.rate)}%</TableCell>
                {canManage && (
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${r.name}`}
                      onClick={() => {
                        setEditing(r);
                        setOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <TaxRateDialog open={open} onOpenChange={setOpen} {...(editing ? { rate: editing } : {})} />
    </Card>
  );
}
