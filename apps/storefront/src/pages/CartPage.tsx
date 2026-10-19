import { Link } from 'react-router';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { Alert, Button, buttonVariants, Skeleton } from '@rhoyards/ui';
import { formatMoney, formatQty } from '../lib/api';
import { cart, useCart } from '../lib/cart';
import { PROBLEM_TEXT, useQuote } from '../lib/quote';

export function CartPage() {
  const items = useCart();
  const quote = useQuote();
  if (items.length === 0) {
    return (
      <section className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="text-2xl font-semibold">Your cart is empty</h1>
        <Link to="/shop" className={`${buttonVariants()} mt-6`}>
          Continue shopping
        </Link>
      </section>
    );
  }
  const q = quote.data;
  const qtyOf = (variantId: string) => items.find((i) => i.variantId === variantId)?.qty ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Your cart</h1>
      {quote.isError && <Alert variant="destructive">Could not check your cart: {quote.error.message}</Alert>}
      {!q && <Skeleton className="h-48 w-full" />}
      {q && (
        <>
          <ul className="divide-y rounded-lg border" aria-busy={quote.isFetching}>
            {q.lines.map((l) => (
              <li key={l.variantId} className="flex gap-4 p-4">
                <div className="size-20 shrink-0 overflow-hidden rounded bg-muted">{l.imageUrl && <img src={l.imageUrl} alt="" className="size-full object-cover" />}</div>
                <div className="flex flex-1 flex-col gap-1">
                  {l.slug ? (
                    <Link to={`/products/${l.slug}`} className="font-medium hover:underline">
                      {l.productName}
                    </Link>
                  ) : (
                    <span className="font-medium">{l.productName || 'Item'}</span>
                  )}
                  <span className="text-sm text-muted-foreground">{l.name}</span>
                  {l.problem && (
                    <span role="alert" className="text-sm font-medium text-destructive">
                      {PROBLEM_TEXT[l.problem]}
                      {l.problem === 'INSUFFICIENT' && ` (${formatQty(l.available)} available)`}
                    </span>
                  )}
                  <div className="mt-1 flex items-center gap-2">
                    <Button variant="outline" size="icon" aria-label={`One less ${l.productName}`} onClick={() => cart.setQty(l.variantId, qtyOf(l.variantId) - 1)}>
                      <Minus />
                    </Button>
                    <span className="w-8 text-center tabular-nums" aria-label="Quantity">
                      {qtyOf(l.variantId)}
                    </span>
                    <Button variant="outline" size="icon" aria-label={`One more ${l.productName}`} onClick={() => cart.setQty(l.variantId, qtyOf(l.variantId) + 1)}>
                      <Plus />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Remove ${l.productName}`} onClick={() => cart.remove(l.variantId)}>
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="text-right tabular-nums">{formatMoney(l.total)}</div>
              </li>
            ))}
          </ul>
          <div className="ml-auto max-w-xs space-y-3">
            <dl className="grid grid-cols-2 gap-1 text-sm">
              <dt className="text-muted-foreground">Items</dt>
              <dd className="text-right font-semibold tabular-nums">{formatMoney(q.itemsTotal)}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">Delivery is chosen at checkout. {q.pricesIncludeTax ? 'Prices include VAT.' : 'VAT is added at checkout.'}</p>
            {q.lines.some((l) => l.problem) ? (
              <Alert variant="destructive">Adjust the items marked above to continue.</Alert>
            ) : (
              <Link to="/checkout" className={`${buttonVariants()} w-full`}>
                Checkout
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
