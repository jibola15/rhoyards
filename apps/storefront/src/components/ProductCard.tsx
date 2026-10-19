import { Link } from 'react-router';
import type { StoreProductCard } from '@rhoyards/shared';
import { formatMoney } from '../lib/api';

export function ProductCard({ product }: { product: StoreProductCard }) {
  const price = product.minPrice === product.maxPrice ? formatMoney(product.minPrice) : `From ${formatMoney(product.minPrice)}`;
  return (
    <Link to={`/products/${product.slug}`} className="group flex flex-col gap-2">
      <div className="aspect-square overflow-hidden rounded-lg bg-muted">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
        ) : (
          <div className="flex size-full items-center justify-center text-xs text-muted-foreground">No photo</div>
        )}
      </div>
      <div>
        {product.brand && <p className="text-xs uppercase tracking-wide text-muted-foreground">{product.brand}</p>}
        <h3 className="font-medium group-hover:underline">{product.name}</h3>
        <p className="text-sm">
          {price}
          {product.compareAtPrice && product.compareAtPrice !== product.minPrice && <span className="ml-2 text-muted-foreground line-through">{formatMoney(product.compareAtPrice)}</span>}
        </p>
        {!product.inStock && <p className="text-xs text-destructive">Out of stock</p>}
      </div>
    </Link>
  );
}

export function ProductGrid({ products }: { products: StoreProductCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <li key={p.id}>
          <ProductCard product={p} />
        </li>
      ))}
    </ul>
  );
}
