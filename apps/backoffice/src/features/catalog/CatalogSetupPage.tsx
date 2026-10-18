import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { z } from 'zod';
import type { BrandSummary, CategorySummary, UnitSummary } from '@rhoyards/shared';
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
import { PageHeader, QueryError } from '../../components/page';
import { api } from '../../lib/api';
import { applyServerErrors } from '../../lib/forms';
import { categoryOptions, useBrands, useCategories, useUnits } from './api';

type Kind = 'brand' | 'category' | 'unit';
type Item = BrandSummary | CategorySummary | UnitSummary;

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  code: z.string().trim().max(10),
  description: z.string().max(500),
  parentId: z.string(),
  allowsFraction: z.boolean(),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

const PATHS: Record<Kind, string> = { brand: '/brands', category: '/categories', unit: '/units' };
const KEYS: Record<Kind, string> = { brand: 'brands', category: 'categories', unit: 'units' };

function ItemForm({ kind, item, onDone }: { kind: Kind; item?: Item | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: item?.name ?? '',
      code: item && 'code' in item ? item.code : '',
      description: item && 'description' in item ? (item.description ?? '') : '',
      parentId: item && 'parentId' in item ? (item.parentId ?? '') : '',
      allowsFraction: item && 'allowsFraction' in item ? item.allowsFraction : false,
      isActive: item?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const body =
        kind === 'unit'
          ? { ...(item ? {} : { code: v.code }), name: v.name, allowsFraction: v.allowsFraction, isActive: v.isActive }
          : kind === 'category'
            ? { name: v.name, description: v.description, parentId: v.parentId || null, isActive: v.isActive }
            : { name: v.name, description: v.description, isActive: v.isActive };
      return item ? api.patch(`${PATHS[kind]}/${item.id}`, body) : api.post(PATHS[kind], body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [KEYS[kind]] });
      toast.success('Saved');
      onDone();
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['name', 'code', 'description', 'parentId'])),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      {kind === 'unit' && (
        <Field id="item-code" label="Code" description="Short code shown on documents, e.g. PC, ML." error={formState.errors.code?.message}>
          <Input disabled={Boolean(item)} className="uppercase" {...register('code')} />
        </Field>
      )}
      <Field id="item-name" label="Name" error={formState.errors.name?.message}>
        <Input {...register('name')} />
      </Field>
      {kind === 'category' && (
        <Field id="item-parent" label="Parent category" error={formState.errors.parentId?.message}>
          <Select {...register('parentId')}>
            <option value="">None (top level)</option>
            {categoryOptions(categories.data)
              .filter((c) => c.id !== item?.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {kind !== 'unit' && (
        <Field id="item-description" label="Description" error={formState.errors.description?.message}>
          <Input {...register('description')} />
        </Field>
      )}
      {kind === 'unit' && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox {...register('allowsFraction')} /> Allow fractional quantities (e.g. litres, kilograms)
        </label>
      )}
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

function SetupCard<T extends Item>({
  kind,
  title,
  description,
  query,
  columns,
}: {
  kind: Kind;
  title: string;
  description: string;
  query: { data?: T[] | undefined; isError: boolean; error: Error | null; refetch: () => unknown };
  columns: { header: string; cell: (item: T) => React.ReactNode; className?: string }[];
}) {
  const { can } = useAuth();
  const canManage = can('catalog.manage');
  const [dialog, setDialog] = useState<{ open: boolean; item?: T }>({ open: false });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setDialog({ open: true })}>
            <Plus />
            Add
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {query.isError && query.error && <QueryError error={query.error} onRetry={() => void query.refetch()} />}
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.header} className={c.className}>
                  {c.header}
                </TableHead>
              ))}
              {canManage && (
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data?.map((item) => (
              <TableRow key={item.id} className={item.isActive ? undefined : 'opacity-60'}>
                {columns.map((c) => (
                  <TableCell key={c.header} className={c.className}>
                    {c.cell(item)}
                  </TableCell>
                ))}
                {canManage && (
                  <TableCell>
                    <Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => setDialog({ open: true, item })}>
                      <Pencil />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {query.data?.length === 0 && <p className="py-4 text-sm text-muted-foreground">None yet.</p>}
      </CardContent>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog.item ? `Edit ${dialog.item.name}` : `New ${kind}`}</DialogTitle>
          </DialogHeader>
          <ItemForm kind={kind} item={dialog.item} onDone={() => setDialog({ open: false })} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const activeBadge = (i: Item) => (i.isActive ? null : <Badge variant="outline">Inactive</Badge>);

export function CatalogSetupPage() {
  const brands = useBrands();
  const categories = useCategories();
  const units = useUnits();
  const parentName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name ?? '—';
  return (
    <div className="space-y-6">
      <PageHeader title="Catalogue setup" description="Brands, categories and units of measure used by products." />
      <div className="grid gap-6 xl:grid-cols-2">
        <SetupCard<BrandSummary>
          kind="brand"
          title="Brands"
          description="Deactivate a brand to stop using it on new products."
          query={brands}
          columns={[
            { header: 'Name', cell: (b) => <span className="flex items-center gap-2">{b.name} {activeBadge(b)}</span> },
            { header: 'Products', cell: (b) => b.productCount, className: 'text-right' },
          ]}
        />
        <SetupCard<CategorySummary>
          kind="category"
          title="Categories"
          description="Nest categories, e.g. Makeup → Lipstick."
          query={categories}
          columns={[
            { header: 'Name', cell: (c) => <span className="flex items-center gap-2">{c.name} {activeBadge(c)}</span> },
            { header: 'Parent', cell: (c) => parentName(c.parentId) },
            { header: 'Products', cell: (c) => c.productCount, className: 'text-right' },
          ]}
        />
        <SetupCard<UnitSummary>
          kind="unit"
          title="Units of measure"
          description="Whole-number units (piece, set) or fractional ones (ml, kg)."
          query={units}
          columns={[
            { header: 'Code', cell: (u) => <span className="font-mono">{u.code}</span> },
            { header: 'Name', cell: (u) => <span className="flex items-center gap-2">{u.name} {activeBadge(u)}</span> },
            { header: 'Fractions', cell: (u) => (u.allowsFraction ? 'Yes' : 'No') },
          ]}
        />
      </div>
    </div>
  );
}
