import { useQuery } from '@tanstack/react-query';
import type {
  BrandSummary,
  CategorySummary,
  DataEnvelope,
  ListEnvelope,
  ProductDetail,
  ProductSummary,
  TaxRateSummary,
  UnitSummary,
} from '@rhoyards/shared';
import { api, qs } from '../../lib/api';

export const catalogKeys = {
  products: ['products'] as const,
  product: (id: string) => ['products', 'detail', id] as const,
};

function useReference<T>(key: string, path: string) {
  return useQuery({
    queryKey: [key],
    queryFn: ({ signal }) => api.get<DataEnvelope<T[]>>(path, { signal }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export const useBrands = () => useReference<BrandSummary>('brands', '/brands');
export const useCategories = () => useReference<CategorySummary>('categories', '/categories');
export const useUnits = () => useReference<UnitSummary>('units', '/units');
export const useTaxRates = () => useReference<TaxRateSummary>('tax-rates', '/tax-rates');

export interface ProductListParams {
  q: string;
  brandId: string;
  categoryId: string;
  status: string;
  includeArchived: boolean;
  page: number;
  pageSize: number;
}

export function useProducts(p: ProductListParams) {
  return useQuery({
    queryKey: [...catalogKeys.products, 'list', p],
    queryFn: ({ signal }) =>
      api.get<ListEnvelope<ProductSummary>>(
        `/products${qs({ ...p, includeArchived: p.includeArchived ? 'true' : undefined })}`,
        { signal },
      ),
    placeholderData: (prev) => prev,
  });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: catalogKeys.product(id ?? 'new'),
    queryFn: ({ signal }) => api.get<DataEnvelope<ProductDetail>>(`/products/${id}`, { signal }).then((r) => r.data),
    enabled: Boolean(id),
  });
}

/** Indents category names by depth for selects: "Makeup", "— Lipstick". */
export function categoryOptions(categories: CategorySummary[] | undefined) {
  const list = categories ?? [];
  const byParent = new Map<string | null, CategorySummary[]>();
  for (const c of list) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const out: { id: string; label: string; isActive: boolean }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      out.push({ id: c.id, label: `${'— '.repeat(depth)}${c.name}`, isActive: c.isActive });
      if (depth < 10) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
