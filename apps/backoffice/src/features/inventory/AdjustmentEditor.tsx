import { useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import { z } from 'zod';
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  costInput,
  positiveQtyInput,
  type AdjustmentDetail,
  type AdjustmentReason,
  type DataEnvelope,
} from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea, toast } from '@rhoyards/ui';
import { VariantPicker } from '../../components/VariantPicker';
import { api } from '../../lib/api';
import { formatQty } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { useLocations } from '../users/api';

const ONLY_IN: AdjustmentReason[] = ['OPENING_STOCK'];
const ONLY_OUT: AdjustmentReason[] = ['DAMAGE', 'EXPIRY', 'THEFT'];

const lineSchema = z.object({
  variantId: z.string().min(1),
  label: z.string(),
  sku: z.string(),
  isBatchTracked: z.boolean(),
  isExpiryTracked: z.boolean(),
  onHand: z.string().nullable(),
  direction: z.enum(['in', 'out']),
  qty: positiveQtyInput,
  unitCost: z.union([z.literal(''), costInput]),
  lotNumber: z.string().max(60),
  expiryDate: z.string(),
  note: z.string().max(300),
});

const formSchema = z
  .object({
    locationId: z.string().min(1, 'Choose a location'),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: z.string().max(1000),
    lines: z.array(lineSchema).min(1, 'Add at least one product'),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      if (l.direction === 'in' && l.unitCost === '') ctx.addIssue({ code: 'custom', path: ['lines', i, 'unitCost'], message: 'Required when adding stock' });
      if (l.direction === 'in' && l.isExpiryTracked && !l.expiryDate) ctx.addIssue({ code: 'custom', path: ['lines', i, 'expiryDate'], message: 'Expiry date required' });
      if (l.direction === 'in' && l.isBatchTracked && !l.isExpiryTracked && !l.lotNumber) ctx.addIssue({ code: 'custom', path: ['lines', i, 'lotNumber'], message: 'Lot number required' });
    });
  });
type FormValues = z.infer<typeof formSchema>;
type Line = FormValues['lines'][number];

const forcedDirection = (reason: AdjustmentReason): 'in' | 'out' | null =>
  ONLY_IN.includes(reason) ? 'in' : ONLY_OUT.includes(reason) ? 'out' : null;

function toPayload(v: FormValues) {
  return {
    locationId: v.locationId,
    reason: v.reason,
    note: v.note,
    lines: v.lines.map((l) => ({
      variantId: l.variantId,
      qtyChange: l.direction === 'out' ? `-${l.qty}` : l.qty,
      ...(l.direction === 'in' ? { unitCost: l.unitCost } : {}),
      ...(l.lotNumber ? { lotNumber: l.lotNumber } : {}),
      ...(l.direction === 'in' && l.expiryDate ? { expiryDate: l.expiryDate } : {}),
      note: l.note,
    })),
  };
}

function fromDetail(a: AdjustmentDetail): FormValues {
  return {
    locationId: a.location.id,
    reason: a.reason,
    note: a.note ?? '',
    lines: a.lines.map((l) => ({
      variantId: l.variant.id,
      label: `${l.variant.productName} — ${l.variant.name}`,
      sku: l.variant.sku,
      isBatchTracked: l.variant.isBatchTracked,
      isExpiryTracked: l.variant.isExpiryTracked,
      onHand: null,
      direction: l.qtyChange.startsWith('-') ? 'out' : 'in',
      qty: formatQty(l.qtyChange.replace('-', '')),
      unitCost: l.unitCost ? formatQty(l.unitCost) : '',
      lotNumber: l.lotNumber ?? '',
      expiryDate: l.expiryDate ?? '',
      note: l.note ?? '',
    })),
  };
}

export function AdjustmentEditor({
  existing,
  initialReason,
  onSaved,
  onCancel,
}: {
  existing?: AdjustmentDetail;
  initialReason?: AdjustmentReason;
  onSaved?: (a: AdjustmentDetail) => void;
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const locations = useLocations();
  const [formError, setFormError] = useState<string | null>(null);
  const defaultLocation = locations.data?.find((l) => l.isActive && l.isPosEnabled)?.id ?? locations.data?.find((l) => l.isActive)?.id ?? '';

  const { register, control, handleSubmit, setValue, setError, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: existing ? fromDetail(existing) : { locationId: defaultLocation, reason: initialReason ?? 'STOCK_COUNT', note: '', lines: [] },
    resetOptions: { keepDirtyValues: true },
  });
  const lines = useFieldArray({ control, name: 'lines' });
  const reason = useWatch({ control, name: 'reason' });
  const locationId = useWatch({ control, name: 'locationId' });
  const watchedLines = useWatch({ control, name: 'lines' });
  const forced = forcedDirection(reason);

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      existing
        ? api.put<DataEnvelope<AdjustmentDetail>>(`/stock-adjustments/${existing.id}`, toPayload(v))
        : api.post<DataEnvelope<AdjustmentDetail>>('/stock-adjustments', toPayload(v)),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['stock-adjustments'] });
      toast.success(`Draft ${res.data.number} saved. Post it to apply the stock change.`);
      if (onSaved) onSaved(res.data);
      else navigate(`/inventory/adjustments/${res.data.id}`, { replace: true });
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, ['locationId', 'reason', 'note'])),
  });

  const lineErrors = formState.errors.lines;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <Field id="adj-location" label="Location" error={formState.errors.locationId?.message}>
            <Select {...register('locationId')}>
              <option value="">Choose…</option>
              {locations.data?.filter((l) => l.isActive).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="adj-reason" label="Reason" error={formState.errors.reason?.message}>
            <Select
              {...register('reason', {
                onChange: (e: { target: { value: AdjustmentReason } }) => {
                  const dir = forcedDirection(e.target.value);
                  if (dir) watchedLines.forEach((_, i) => setValue(`lines.${i}.direction`, dir));
                },
              })}
            >
              {ADJUSTMENT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {ADJUSTMENT_REASON_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="adj-note" label="Note" className="sm:col-span-2">
            <Textarea rows={2} placeholder="e.g. Monthly count, shelf B" {...register('note')} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <VariantPicker
            locationId={locationId || undefined}
            onSelect={(v) =>
              lines.append({
                variantId: v.id,
                label: `${v.productName} — ${v.name}`,
                sku: v.sku,
                isBatchTracked: v.isBatchTracked,
                isExpiryTracked: v.isExpiryTracked,
                onHand: v.qtyOnHand,
                direction: forced ?? 'in',
                qty: '',
                unitCost: Number(v.avgCost) > 0 ? formatQty(v.avgCost) : '',
                lotNumber: '',
                expiryDate: '',
                note: '',
              })
            }
          />
          {lineErrors?.root?.message && <Alert variant="destructive">{lineErrors.root.message}</Alert>}
          {lineErrors?.message && <Alert variant="destructive">{lineErrors.message}</Alert>}
          {lines.fields.length === 0 && <p className="text-sm text-muted-foreground">Search or scan products to add them.</p>}
          {lines.fields.map((f, i) => {
            const line: Line | undefined = watchedLines[i];
            const e = lineErrors?.[i];
            const direction = forced ?? line?.direction ?? 'in';
            return (
              <div key={f.id} className="grid gap-3 rounded-md border p-3 md:grid-cols-12">
                <div className="md:col-span-4">
                  <div className="text-sm font-medium">{f.label}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {f.sku}
                    {line?.onHand !== null && line?.onHand !== undefined && ` · ${formatQty(line.onHand)} on hand`}
                  </div>
                </div>
                <Field id={`l-${i}-dir`} label="Change" className="md:col-span-2">
                  <Select disabled={forced !== null} {...register(`lines.${i}.direction`)}>
                    <option value="in">Add (+)</option>
                    <option value="out">Remove (−)</option>
                  </Select>
                </Field>
                <Field id={`l-${i}-qty`} label="Quantity" error={e?.qty?.message} className="md:col-span-2">
                  <Input inputMode="decimal" {...register(`lines.${i}.qty`)} />
                </Field>
                {direction === 'in' ? (
                  <Field id={`l-${i}-cost`} label="Unit cost (₦)" error={e?.unitCost?.message} className="md:col-span-2">
                    <Input inputMode="decimal" {...register(`lines.${i}.unitCost`)} />
                  </Field>
                ) : (
                  <p className="self-end pb-2 text-xs text-muted-foreground md:col-span-2">Valued at average cost when posted.</p>
                )}
                <div className="flex items-end justify-end md:col-span-2">
                  <Button variant="ghost" size="sm" aria-label={`Remove ${f.label}`} onClick={() => lines.remove(i)}>
                    <Trash2 />
                  </Button>
                </div>
                {f.isBatchTracked && (
                  <>
                    <Field
                      id={`l-${i}-lot`}
                      label={direction === 'in' ? 'Lot number' : 'Lot (optional)'}
                      description={direction === 'out' ? 'Leave blank to take the earliest-expiring lot.' : f.isExpiryTracked ? 'Generated from the expiry date if blank.' : undefined}
                      error={e?.lotNumber?.message}
                      className="md:col-span-4"
                    >
                      <Input className="font-mono" {...register(`lines.${i}.lotNumber`)} />
                    </Field>
                    {direction === 'in' && (
                      <Field id={`l-${i}-exp`} label="Expiry date" error={e?.expiryDate?.message} className="md:col-span-3">
                        <Input type="date" {...register(`lines.${i}.expiryDate`)} />
                      </Field>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
