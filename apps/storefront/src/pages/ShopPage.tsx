import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DataEnvelope, ListEnvelope, StoreFacets, StoreProductCard } from '@rhoyards/shared';
import { Button, Checkbox, Field, Input, Select, Skeleton } from '@rhoyards/ui';
import { ProductGrid } from '../components/ProductCard';
import { api, qs } from '../lib/api';

const PAGE_SIZE = 24;

export function ShopPage() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const page = Number(get('page') || 1);
  const query = { q: get('q'), category: get('category'), brand: get('brand'), minPrice: get('minPrice'), maxPrice: get('maxPrice'), inStock: get('inStock'), sort: get('sort') || 'newest', page, pageSize: PAGE_SIZE };
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next);
  };
  const facets = useQuery({
    queryKey: ['store', 'facets'],
    queryFn: ({ signal }) => api.get<DataEnvelope<StoreFacets>>('/catalog/facets', { signal }).then((r) => r.data),
    staleTime: 60_000,
  });
  const products = useQuery<ListEnvelope<StoreProductCard>>({
    queryKey: ['store', 'products', query],
    queryFn: ({ signal }) => api.get<ListEnvelope<StoreProductCard>>(`/catalog/products${qs(query)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((products.data?.meta.total ?? 0) / PAGE_SIZE));

  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 md:grid-cols-[14rem_1fr]">
      <aside aria-label="Filters" className="space-y-4">
        <Field id="f-q" label="Search">
          <Input type="search" defaultValue={query.q} key={query.q} onKeyDown={(e) => e.key === 'Enter' && set('q', e.currentTarget.value.trim())} />
        </Field>
        <Field id="f-cat" label="Category">
          <Select value={query.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">All</option>
            {facets.data?.categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name} ({c.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field id="f-brand" label="Brand">
          <Select value={query.brand} onChange={(e) => set('brand', e.target.value)}>
            <option value="">All</option>
            {facets.data?.brands.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name} ({b.count})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id="f-min" label="Min ₦">
            <Input inputMode="numeric" defaultValue={query.minPrice} onBlur={(e) => set('minPrice', e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <Field id="f-max" label="Max ₦">
            <Input inputMode="numeric" defaultValue={query.maxPrice} onBlur={(e) => set('maxPrice', e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={query.inStock === 'true'} onChange={(e) => set('inStock', e.target.checked ? 'true' : '')} /> In stock only
        </label>
      </aside>
      <section aria-labelledby="shop-heading" className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="shop-heading" className="text-2xl font-semibold">
              {query.q ? `Results for “${query.q}”` : 'Shop'}
            </h1>
            {products.data && <p className="text-sm text-muted-foreground">{products.data.meta.total} products</p>}
          </div>
          <Field id="f-sort" label="Sort by" className="w-44">
            <Select value={query.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="newest">Newest</option>
              <option value="price:asc">Price: low to high</option>
              <option value="price:desc">Price: high to low</option>
              <option value="name:asc">Name</option>
            </Select>
          </Field>
        </div>
        {products.isPending && <Skeleton className="h-96 w-full" />}
        {products.isError && <p className="text-destructive">Could not load products. Please try again.</p>}
        {products.data && (products.data.data.length > 0 ? <ProductGrid products={products.data.data} /> : <p className="py-12 text-center text-muted-foreground">No products match these filters.</p>)}
        {pages > 1 && (
          <nav aria-label="Pagination" className="flex items-center justify-center gap-3 text-sm">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>
              Previous
            </Button>
            <span>
              Page {page} of {pages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => set('page', String(page + 1))}>
              Next
            </Button>
          </nav>
        )}
      </section>
    </div>
  );
}
