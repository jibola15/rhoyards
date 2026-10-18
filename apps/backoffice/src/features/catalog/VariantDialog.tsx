import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, type DataEnvelope, type ProductDetail, type VariantDetail } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  toast,
} from '@rhoyards/ui';
import { api } from '../../lib/api';
import { applyServerErrors } from '../../lib/forms';
import { catalogKeys, useUnits } from './api';
import { emptyVariant, variantFormSchema, variantPayload, variantToForm, type VariantFormValues } from './variant-form';

const FIELDS = ['sku', 'name', 'shade', 'colour', 'tone', 'size', 'volumeValue', 'sellingPrice', 'compareAtPrice', 'standardCost', 'reorderLevel', 'reorderQty', 'barcodesText'];

function VariantForm({ productId, variant, onDone }: { productId: string; variant?: VariantDetail | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const units = useUnits();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<VariantFormValues>({
    resolver: zodResolver(variantFormSchema),
    defaultValues: variant ? variantToForm(variant) : emptyVariant(),
  });
  const e = formState.errors;

  const mutation = useMutation({
    mutationFn: (values: VariantFormValues) => {
      const body = variantPayload(values);
      return variant
        ? api.patch<DataEnvelope<ProductDetail>>(`/variants/${variant.id}`, body)
        : api.post<DataEnvelope<ProductDetail>>(`/products/${productId}/variants`, body);
    },
    onSuccess: (res) => {
      queryClient.setQueryData(catalogKeys.product(productId), res.data);
      void queryClient.invalidateQueries({ queryKey: catalogKeys.products });
      toast.success(variant ? 'Variant saved' : 'Variant added');
      onDone();
    },
    onError: (err) => {
      // The server reports barcode clashes on "barcodes"; the form field is "barcodesText".
      if (err instanceof ApiError && (err.details as { field?: string } | undefined)?.field === 'barcodes') {
        setError('barcodesText', { message: err.message });
        setFormError(null);
        return;
      }
      setFormError(applyServerErrors(err, setError, FIELDS));
    },
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="v-name" label="Variant name" error={e.name?.message}>
          <Input placeholder="e.g. Ruby Red / 30 ml" {...register('name')} />
        </Field>
        <Field id="v-sku" label="SKU" error={e.sku?.message}>
          <Input className="font-mono uppercase" {...register('sku')} />
        </Field>
        <Field id="v-price" label="Selling price (₦)" error={e.sellingPrice?.message}>
          <Input inputMode="decimal" {...register('sellingPrice')} />
        </Field>
        <Field id="v-compare" label="Compare-at price (₦)" description="Optional “was” price." error={e.compareAtPrice?.message}>
          <Input inputMode="decimal" {...register('compareAtPrice')} />
        </Field>
        <Field id="v-shade" label="Shade" error={e.shade?.message}>
          <Input {...register('shade')} />
        </Field>
        <Field id="v-colour" label="Colour" error={e.colour?.message}>
          <Input {...register('colour')} />
        </Field>
        <Field id="v-tone" label="Tone / undertone" error={e.tone?.message}>
          <Input {...register('tone')} />
        </Field>
        <Field id="v-size" label="Size" error={e.size?.message}>
          <Input {...register('size')} />
        </Field>
        <Field id="v-volume" label="Volume / net content" error={e.volumeValue?.message}>
          <Input inputMode="decimal" {...register('volumeValue')} />
        </Field>
        <Field id="v-volume-unit" label="Volume unit">
          <Select {...register('volumeUnitId')}>
            <option value="">—</option>
            {units.data?.filter((u) => u.isActive).map((u) => (
              <option key={u.id} value={u.id}>
                {u.code} — {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="v-reorder" label="Reorder level" description="Low-stock alert at or below this quantity." error={e.reorderLevel?.message}>
          <Input inputMode="decimal" {...register('reorderLevel')} />
        </Field>
        <Field id="v-reorder-qty" label="Reorder quantity" error={e.reorderQty?.message}>
          <Input inputMode="decimal" {...register('reorderQty')} />
        </Field>
        <Field id="v-cost" label="Standard cost (₦)" description="Planning reference only; stock is valued at average cost." error={e.standardCost?.message}>
          <Input inputMode="decimal" {...register('standardCost')} />
        </Field>
        <Field id="v-status" label="Status">
          <Select {...register('status')}>
            <option value="ACTIVE">Active</option>
            <option value="DISCONTINUED">Discontinued</option>
          </Select>
        </Field>
      </div>
      <Field id="v-barcodes" label="Barcodes" description="Separate several with commas. The first is the primary barcode." error={e.barcodesText?.message}>
        <Input className="font-mono" {...register('barcodesText')} />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : variant ? 'Save variant' : 'Add variant'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function VariantDialog({
  productId,
  variant,
  open,
  onOpenChange,
}: {
  productId: string;
  variant?: VariantDetail | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{variant ? `Edit ${variant.name}` : 'Add variant'}</DialogTitle>
          <DialogDescription>Price changes apply to new sales and are recorded in the audit log.</DialogDescription>
        </DialogHeader>
        <VariantForm productId={productId} variant={variant} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
