import { useRef, useState } from 'react';
import { useFieldArray, useForm, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { Archive, ArchiveRestore, ArrowLeft, ImagePlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import { z } from 'zod';
import type { DataEnvelope, ProductDetail } from '@rhoyards/shared';
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
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader, QueryError } from '../../components/page';
import { StatusBadge } from '../../components/StatusBadge';
import { api } from '../../lib/api';
import { barcodeFieldKeyDown } from '../../lib/scanner';
import { formatMoney, formatQty } from '../../lib/format';
import { applyServerErrors } from '../../lib/forms';
import { catalogKeys, categoryOptions, useBrands, useCategories, useProduct, useTaxRates, useUnits } from './api';
import { VariantDialog } from './VariantDialog';
import { emptyVariant, variantFormSchema, variantPayload } from './variant-form';

const detailsSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(160),
  brandId: z.string(),
  categoryId: z.string(),
  unitId: z.string().min(1, 'Choose a unit'),
  taxRateId: z.string().min(1, 'Choose a tax rate'),
  description: z.string().max(5000),
  isBatchTracked: z.boolean(),
  isExpiryTracked: z.boolean(),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED']),
  onlineVisible: z.boolean(),
});
const createSchema = detailsSchema.extend({ variants: z.array(variantFormSchema).min(1, 'Add at least one variant') });
type DetailsValues = z.infer<typeof detailsSchema>;
type CreateValues = z.infer<typeof createSchema>;

const DETAIL_FIELDS = ['name', 'brandId', 'categoryId', 'unitId', 'taxRateId', 'description', 'status'];
const detailsPayload = (v: DetailsValues) => ({
  ...v,
  brandId: v.brandId || null,
  categoryId: v.categoryId || null,
  description: v.description.trim() || null,
  isBatchTracked: v.isBatchTracked || v.isExpiryTracked,
});

/** Product-level fields, shared by the create and edit forms. */
function DetailsFields({
  register,
  errors,
  disabled,
  trackingLocked,
}: {
  register: UseFormRegister<DetailsValues>;
  errors: Partial<Record<keyof DetailsValues, { message?: string }>>;
  disabled: boolean;
  trackingLocked: boolean;
}) {
  const brands = useBrands();
  const categories = useCategories();
  const units = useUnits();
  const taxRates = useTaxRates();
  return (
    <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
      <Field id="p-name" label="Product name" error={errors.name?.message} className="sm:col-span-2">
        <Input {...register('name')} />
      </Field>
      <Field id="p-brand" label="Brand" error={errors.brandId?.message}>
        <Select {...register('brandId')}>
          <option value="">No brand</option>
          {brands.data?.map((b) => (
            <option key={b.id} value={b.id} disabled={!b.isActive}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="p-category" label="Category" error={errors.categoryId?.message}>
        <Select {...register('categoryId')}>
          <option value="">Uncategorised</option>
          {categoryOptions(categories.data).map((c) => (
            <option key={c.id} value={c.id} disabled={!c.isActive}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="p-unit" label="Selling unit" error={errors.unitId?.message} description={trackingLocked ? 'Locked while the product has stock.' : undefined}>
        <Select disabled={trackingLocked} {...register('unitId')}>
          <option value="">Choose…</option>
          {units.data?.filter((u) => u.isActive).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.code})
            </option>
          ))}
        </Select>
      </Field>
      <Field id="p-tax" label="Tax rate" error={errors.taxRateId?.message}>
        <Select {...register('taxRateId')}>
          <option value="">Choose…</option>
          {taxRates.data?.filter((t) => t.isActive).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({Number(t.rate)}%)
            </option>
          ))}
        </Select>
      </Field>
      <Field id="p-status" label="Status" error={errors.status?.message}>
        <Select {...register('status')}>
          <option value="ACTIVE">Active — can be sold</option>
          <option value="DRAFT">Draft — not yet for sale</option>
          <option value="DISCONTINUED">Discontinued</option>
        </Select>
      </Field>
      <div className="grid content-start gap-2 pt-6 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox {...register('onlineVisible')} /> Show in the online store
        </label>
        <label className="flex items-center gap-2">
          <Checkbox disabled={trackingLocked} {...register('isExpiryTracked')} /> Track expiry dates (FEFO)
        </label>
        <label className="flex items-center gap-2">
          <Checkbox disabled={trackingLocked} {...register('isBatchTracked')} /> Track batch / lot numbers
        </label>
      </div>
      <Field id="p-description" label="Description" error={errors.description?.message} className="sm:col-span-2">
        <Textarea rows={4} {...register('description')} />
      </Field>
    </fieldset>
  );
}

function NewProductForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taxRates = useTaxRates();
  const units = useUnits();
  const [formError, setFormError] = useState<string | null>(null);
  const defaultTax = taxRates.data?.find((t) => t.code === 'VAT')?.id ?? '';
  const defaultUnit = units.data?.find((u) => u.code === 'PC')?.id ?? '';
  const { register, control, handleSubmit, setError, setValue, formState } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    values: {
      name: '',
      brandId: '',
      categoryId: '',
      unitId: defaultUnit,
      taxRateId: defaultTax,
      description: '',
      isBatchTracked: false,
      isExpiryTracked: false,
      status: 'ACTIVE',
      onlineVisible: false,
      variants: [emptyVariant()],
    },
    resetOptions: { keepDirtyValues: true },
  });
  const variants = useFieldArray({ control, name: 'variants' });

  const mutation = useMutation({
    mutationFn: (v: CreateValues) =>
      api.post<DataEnvelope<ProductDetail>>('/products', { ...detailsPayload(v), variants: v.variants.map(variantPayload) }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.products });
      toast.success('Product created');
      navigate(`/catalog/products/${res.data.id}`, { replace: true });
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, DETAIL_FIELDS)),
  });
  const ve = formState.errors.variants;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-6">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailsFields register={register as unknown as UseFormRegister<DetailsValues>} errors={formState.errors} disabled={false} trackingLocked={false} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Variants</CardTitle>
          <CardDescription>One row per sellable shade, size or volume. More attributes can be added after saving.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ve?.root?.message && <Alert variant="destructive">{ve.root.message}</Alert>}
          {variants.fields.map((f, i) => (
            <div key={f.id} className="grid gap-3 rounded-md border p-3 sm:grid-cols-6">
              <Field id={`nv-${i}-name`} label="Name" error={ve?.[i]?.name?.message} className="sm:col-span-2">
                <Input placeholder="e.g. Ruby Red" {...register(`variants.${i}.name`)} />
              </Field>
              <Field id={`nv-${i}-sku`} label="SKU" error={ve?.[i]?.sku?.message}>
                <Input className="font-mono uppercase" {...register(`variants.${i}.sku`)} />
              </Field>
              <Field id={`nv-${i}-shade`} label="Shade / size" error={ve?.[i]?.shade?.message}>
                <Input {...register(`variants.${i}.shade`)} />
              </Field>
              <Field id={`nv-${i}-price`} label="Price (₦)" error={ve?.[i]?.sellingPrice?.message}>
                <Input inputMode="decimal" {...register(`variants.${i}.sellingPrice`)} />
              </Field>
              <Field id={`nv-${i}-reorder`} label="Reorder at" error={ve?.[i]?.reorderLevel?.message}>
                <Input inputMode="decimal" {...register(`variants.${i}.reorderLevel`)} />
              </Field>
              <Field id={`nv-${i}-barcode`} label="Barcode(s)" error={ve?.[i]?.barcodesText?.message} className="sm:col-span-5">
                <Input
                  className="font-mono"
                  {...register(`variants.${i}.barcodesText`)}
                  onKeyDown={(e) => barcodeFieldKeyDown(e, (v) => setValue(`variants.${i}.barcodesText`, v, { shouldDirty: true }))}
                />
              </Field>
              <div className="flex items-end">
                <Button variant="ghost" size="sm" disabled={variants.fields.length === 1} onClick={() => variants.remove(i)}>
                  <Trash2 />
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <Button variant="outline" onClick={() => variants.append(emptyVariant())}>
            <Plus />
            Add another variant
          </Button>
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create product'}
        </Button>
        <Link to="/catalog/products" className="inline-flex items-center px-3 text-sm text-muted-foreground hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function ImagesCard({ product, canManage }: { product: ProductDetail; canManage: boolean }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const setProduct = (p: ProductDetail) => {
    queryClient.setQueryData(catalogKeys.product(product.id), p);
    void queryClient.invalidateQueries({ queryKey: catalogKeys.products });
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const stored = await api.post<DataEnvelope<{ id: string }>>('/files/images', form);
      const res = await api.post<DataEnvelope<ProductDetail>>(`/products/${product.id}/images`, { fileId: stored.data.id, altText: product.name });
      setProduct(res.data);
      toast.success('Image added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>Images</CardTitle>
          <CardDescription>JPEG, PNG or WebP. Images are resized and re-encoded on upload.</CardDescription>
        </div>
        {canManage && (
          <>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Upload product image"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
              <ImagePlus />
              {busy ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        )}
      </CardHeader>
      <CardContent>
        {product.images.length === 0 ? (
          <p className="text-sm text-muted-foreground">No images yet.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {product.images.map((img) => (
              <li key={img.id} className="relative overflow-hidden rounded-md border">
                <img src={img.url} alt={img.altText ?? ''} className="aspect-square w-full object-cover" loading="lazy" />
                {canManage && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute right-1 top-1 size-7"
                    aria-label="Remove image"
                    onClick={async () => {
                      try {
                        const res = await api.delete<DataEnvelope<ProductDetail>>(`/products/${product.id}/images/${img.id}`);
                        setProduct(res.data);
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Could not remove image');
                      }
                    }}
                  >
                    <X />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function EditProduct({ product }: { product: ProductDetail }) {
  const { can } = useAuth();
  const canManage = can('catalog.manage') && !product.archived;
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [variantDialog, setVariantDialog] = useState<{ open: boolean; variantId?: string }>({ open: false });
  const [confirmArchive, setConfirmArchive] = useState(false);
  const hasStock = product.variants.some((v) => Number(v.stockQty) !== 0);
  const setProduct = (p: ProductDetail) => {
    queryClient.setQueryData(catalogKeys.product(product.id), p);
    void queryClient.invalidateQueries({ queryKey: catalogKeys.products });
  };

  const { register, handleSubmit, setError, formState, reset } = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: {
      name: product.name,
      brandId: product.brand?.id ?? '',
      categoryId: product.category?.id ?? '',
      unitId: product.unit.id,
      taxRateId: product.taxRate.id,
      description: product.description ?? '',
      isBatchTracked: product.isBatchTracked,
      isExpiryTracked: product.isExpiryTracked,
      status: product.status,
      onlineVisible: product.onlineVisible,
    },
  });

  const save = useMutation({
    mutationFn: (v: DetailsValues) => api.patch<DataEnvelope<ProductDetail>>(`/products/${product.id}`, detailsPayload(v)),
    onSuccess: (res, v) => {
      setProduct(res.data);
      reset(v);
      setFormError(null);
      toast.success('Product saved');
    },
    onError: (err) => setFormError(applyServerErrors(err, setError, DETAIL_FIELDS)),
  });

  const toggleVariant = async (id: string, archive: boolean) => {
    try {
      const res = await api.post<DataEnvelope<ProductDetail>>(`/variants/${id}/${archive ? 'archive' : 'restore'}`);
      setProduct(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update variant');
    }
  };

  const editing = product.variants.find((v) => v.id === variantDialog.variantId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={product.status} />
        {product.archived && <Badge variant="outline">Archived</Badge>}
        {product.isExpiryTracked && <Badge variant="secondary">Expiry tracked</Badge>}
        {product.isBatchTracked && !product.isExpiryTracked && <Badge variant="secondary">Batch tracked</Badge>}
        {can('catalog.manage') && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setConfirmArchive(true)}>
            {product.archived ? <ArchiveRestore /> : <Archive />}
            {product.archived ? 'Restore' : 'Archive'}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate className="space-y-4">
            {formError && <Alert variant="destructive">{formError}</Alert>}
            <DetailsFields register={register} errors={formState.errors} disabled={!canManage} trackingLocked={hasStock} />
            {canManage && (
              <Button type="submit" disabled={save.isPending || !formState.isDirty}>
                {save.isPending ? 'Saving…' : 'Save details'}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Variants</CardTitle>
            <CardDescription>Stock and average cost are maintained by stock transactions, not edited here.</CardDescription>
          </div>
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => setVariantDialog({ open: true })}>
              <Plus />
              Add variant
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead>SKU / barcode</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Avg cost</TableHead>
                <TableHead className="text-right">In stock</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {product.variants.map((v) => (
                <TableRow key={v.id} className={v.archived ? 'opacity-60' : undefined}>
                  <TableCell>
                    <div className="font-medium">{v.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[v.shade, v.colour, v.tone, v.size, v.volumeValue && `${Number(v.volumeValue)} ${v.volumeUnit?.code ?? ''}`].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{v.sku}</div>
                    <div className="font-mono text-xs text-muted-foreground">{v.barcodes[0] ?? 'no barcode'}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(v.sellingPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(v.avgCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Link to={`/inventory/movements?variantId=${v.id}`} className="hover:underline">
                      {formatQty(v.stockQty)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {v.archived ? <Badge variant="outline">Archived</Badge> : <StatusBadge status={v.status} />}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label={`Edit ${v.name}`} onClick={() => setVariantDialog({ open: true, variantId: v.id })}>
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={v.archived ? `Restore ${v.name}` : `Archive ${v.name}`}
                          onClick={() => void toggleVariant(v.id, !v.archived)}
                        >
                          {v.archived ? <ArchiveRestore /> : <Archive />}
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ImagesCard product={product} canManage={canManage} />

      <VariantDialog
        productId={product.id}
        variant={editing}
        open={variantDialog.open}
        onOpenChange={(open) => setVariantDialog((s) => ({ ...s, open }))}
      />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={product.archived ? `Restore ${product.name}?` : `Archive ${product.name}?`}
        description={
          product.archived
            ? 'The product will appear in lists and can be sold again.'
            : 'Archived products are hidden from lists and cannot be sold. Their history is kept. Stock must be zero.'
        }
        confirmLabel={product.archived ? 'Restore' : 'Archive'}
        destructive={!product.archived}
        onConfirm={async () => {
          try {
            const res = await api.post<DataEnvelope<ProductDetail>>(`/products/${product.id}/${product.archived ? 'restore' : 'archive'}`);
            setProduct(res.data);
            toast.success(product.archived ? 'Product restored' : 'Product archived');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Action failed');
          }
        }}
      />
    </div>
  );
}

export function ProductEditorPage() {
  const { id } = useParams();
  const product = useProduct(id);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/catalog/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Products
      </Link>
      <PageHeader title={id ? (product.data?.name ?? 'Product') : 'New product'} />
      {!id && <NewProductForm />}
      {id && product.isPending && <Skeleton className="h-96 w-full" />}
      {id && product.isError && <QueryError error={product.error} onRetry={() => void product.refetch()} />}
      {/* Keyed so the form re-initialises when another product is opened. */}
      {product.data && <EditProduct key={product.data.id} product={product.data} />}
    </div>
  );
}
