import { useState } from 'react';
import { Link } from 'react-router';
import { ImageOff, Plus, Search } from 'lucide-react';
import {
  Badge,
  buttonVariants,
  Card,
  CardContent,
  Checkbox,
  Input,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { StatusBadge } from '../../components/StatusBadge';
import { formatPriceRange, formatQty } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { categoryOptions, useBrands, useCategories, useProducts } from './api';

const PAGE_SIZE = 25;

export function ProductsPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [brandId, setBrandId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim());
  const brands = useBrands();
  const categories = useCategories();
  const products = useProducts({ q, brandId, categoryId, status, includeArchived, page, pageSize: PAGE_SIZE });
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const filtered = Boolean(q || brandId || categoryId || status);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="Every sellable variant has its own SKU, barcode, price and stock."
        actions={
          can('catalog.manage') && (
            <Link to="/catalog/products/new" className={buttonVariants()}>
              <Plus />
              New product
            </Link>
          )
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                aria-label="Search products"
                placeholder="Name, SKU, barcode or brand"
                className="pl-8"
                value={search}
                onChange={(e) => reset(setSearch)(e.target.value)}
              />
            </div>
            <Select aria-label="Brand" value={brandId} onChange={(e) => reset(setBrandId)(e.target.value)}>
              <option value="">All brands</option>
              {brands.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Category" value={categoryId} onChange={(e) => reset(setCategoryId)(e.target.value)}>
              <option value="">All categories</option>
              {categoryOptions(categories.data).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Status" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
              <option value="">Any status</option>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="DISCONTINUED">Discontinued</option>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={includeArchived} onChange={(e) => reset(setIncludeArchived)(e.target.checked)} />
            Include archived products
          </label>

          {products.isError ? (
            <QueryError error={products.error} onRetry={() => void products.refetch()} />
          ) : (
            <>
              <Table aria-busy={products.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">
                      <span className="sr-only">Image</span>
                    </TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="hidden md:table-cell">Category</TableHead>
                    <TableHead className="text-right">Variants</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">In stock</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.isPending &&
                    Array.from({ length: 5 }, (_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={7}>
                          <Skeleton className="h-8 w-full" />
                        </TableCell>
                      </TableRow>
                    ))}
                  {products.data?.data.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        {p.imageUrl ? (
                          <img src={p.imageUrl} alt="" className="size-10 rounded object-cover" loading="lazy" />
                        ) : (
                          <div className="flex size-10 items-center justify-center rounded bg-muted text-muted-foreground">
                            <ImageOff className="size-4" aria-hidden="true" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Link to={`/catalog/products/${p.id}`} className="font-medium hover:underline">
                          {p.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">{p.brand?.name ?? 'No brand'}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{p.category?.name ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.variantCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPriceRange(p.priceMin, p.priceMax)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatQty(p.stockQty)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge status={p.status} />
                          {p.archived && <Badge variant="outline">Archived</Badge>}
                          {p.onlineVisible && !p.archived && <Badge variant="secondary">Online</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {products.data && products.data.data.length === 0 && (
                <EmptyState title={filtered ? 'No products match your filters' : 'No products yet'}>
                  {!filtered && can('catalog.manage') && 'Create your first product to start selling.'}
                </EmptyState>
              )}
              {products.data && products.data.meta.total > 0 && (
                <Pagination page={page} pageSize={PAGE_SIZE} total={products.data.meta.total} onPageChange={setPage} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
