import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError, type DataEnvelope, type StoreProductDetail, type StoreVariant } from '@rhoyards/shared';
import { Button, Input, Skeleton, toast } from '@rhoyards/ui';
import { api, formatMoney } from '../lib/api';
import { cart } from '../lib/cart';
import { NotFoundPage } from './NotFoundPage';

const STOCK_LABEL: Record<StoreVariant['stock'], string> = { IN_STOCK: 'In stock', LOW: 'Only a few left', OUT: 'Out of stock' };
const variantLabel = (v: StoreVariant) => [v.name, v.shade, v.colour, v.size, v.volume].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ');

export function ProductPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const product = useQuery({
    queryKey: ['store', 'product', slug],
    queryFn: ({ signal }) => api.get<DataEnvelope<StoreProductDetail>>(`/catalog/products/${slug}`, { signal }).then((r) => r.data),
  });
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [imageIndex, setImageIndex] = useState(0);

  if (product.isError) return product.error instanceof ApiError && product.error.status === 404 ? <NotFoundPage /> : <p className="p-8 text-destructive">Could not load this product.</p>;
  if (!product.data) return <Skeleton className="mx-auto my-8 h-96 max-w-6xl" />;
  const p = product.data;
  const variant = p.variants.find((v) => v.id === variantId) ?? p.variants.find((v) => v.stock !== 'OUT') ?? p.variants[0]!;
  const images = p.images.length > 0 ? p.images : [];
  const shown = images[Math.min(imageIndex, images.length - 1)];

  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 md:grid-cols-2">
      <div className="space-y-3">
        <div className="aspect-square overflow-hidden rounded-lg bg-muted">
          {shown ? <img src={shown.url} alt={shown.alt ?? p.name} className="size-full object-cover" /> : <div className="flex size-full items-center justify-center text-muted-foreground">No photo</div>}
        </div>
        {images.length > 1 && (
          <div className="flex gap-2">
            {images.map((img, i) => (
              <button key={img.url} type="button" onClick={() => setImageIndex(i)} className={`size-16 overflow-hidden rounded border ${i === imageIndex ? 'ring-2 ring-primary' : ''}`} aria-label={`Show photo ${i + 1}`}>
                <img src={img.url} alt="" className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-5">
        <div>
          {p.brand && (
            <Link to={`/shop?brand=${p.brand.slug}`} className="text-sm uppercase tracking-wide text-muted-foreground hover:underline">
              {p.brand.name}
            </Link>
          )}
          <h1 className="text-2xl font-semibold">{p.name}</h1>
          <p className="mt-2 text-xl">
            {formatMoney(variant.price)}
            {variant.compareAtPrice && <span className="ml-2 text-base text-muted-foreground line-through">{formatMoney(variant.compareAtPrice)}</span>}
          </p>
          <p className="text-xs text-muted-foreground">{p.pricesIncludeTax ? 'VAT included' : 'Plus VAT'}</p>
        </div>
        {p.variants.length > 1 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Options</legend>
            <div className="flex flex-wrap gap-2">
              {p.variants.map((v) => (
                <Button key={v.id} variant={v.id === variant.id ? 'default' : 'outline'} size="sm" aria-pressed={v.id === variant.id} onClick={() => (setVariantId(v.id), setQty(1))}>
                  {variantLabel(v)}
                </Button>
              ))}
            </div>
          </fieldset>
        )}
        <p className={`text-sm font-medium ${variant.stock === 'OUT' ? 'text-destructive' : ''}`}>{STOCK_LABEL[variant.stock]}</p>
        <div className="flex items-end gap-3">
          <label className="grid gap-1.5 text-sm font-medium">
            Quantity
            <Input type="number" min={1} max={Math.max(variant.maxQty, 1)} value={qty} className="w-20" onChange={(e) => setQty(Math.max(1, Math.min(Number(e.target.value) || 1, variant.maxQty)))} />
          </label>
          <Button
            disabled={variant.stock === 'OUT'}
            onClick={() => {
              cart.add(variant.id, qty);
              toast.success(`${p.name} added to your cart`, { action: { label: 'View cart', onClick: () => navigate('/cart') } });
            }}
          >
            Add to cart
          </Button>
        </div>
        {p.description && <div className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{p.description}</div>}
      </div>
    </div>
  );
}
