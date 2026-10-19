import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { ListEnvelope, StoreProductCard } from '@rhoyards/shared';
import { buttonVariants, Skeleton } from '@rhoyards/ui';
import { useStoreInfo } from '../lib/store-info';
import { ProductGrid } from '../components/ProductCard';
import { STORE_NAME } from '../config';
import { api } from '../lib/api';

export function HomePage() {
  const info = useStoreInfo();
  const newest = useQuery({
    queryKey: ['store', 'products', 'newest'],
    queryFn: ({ signal }) => api.get<ListEnvelope<StoreProductCard>>('/catalog/products?sort=newest&pageSize=8', { signal }).then((r) => r.data),
  });
  return (
    <>
      <section className="border-b bg-muted/40">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:py-20">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{info.data?.name ?? STORE_NAME}</h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">Hair, skin and beauty essentials, delivered across Nigeria or ready to collect from our store.</p>
          {info.data && !info.data.onlineEnabled && <p className="mt-4 text-sm font-medium">Online ordering is paused at the moment. Please visit us in store.</p>}
          <Link to="/shop" className={`${buttonVariants()} mt-8`}>
            Shop now
          </Link>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-12">
        <h2 className="mb-6 text-xl font-semibold">New in</h2>
        {newest.isPending && <Skeleton className="h-64 w-full" />}
        {newest.data && newest.data.length > 0 && <ProductGrid products={newest.data} />}
        {newest.data?.length === 0 && <p className="text-muted-foreground">New products are on their way.</p>}
      </section>
    </>
  );
}
