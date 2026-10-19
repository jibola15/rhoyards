import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { addressSchema, NIGERIAN_STATES, type AddressInput, type DataEnvelope, type PaymentProviderCode, type StoreAddress, type StoreOrder } from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Field, Input, Select, Skeleton, Textarea } from '@rhoyards/ui';
import { useCustomer } from '../account/CustomerProvider';
import { useStoreInfo } from '../lib/store-info';
import { api, formatMoney } from '../lib/api';
import { cart, cartPayload, useCart } from '../lib/cart';
import { PROBLEM_TEXT, useQuote } from '../lib/quote';

type AddressForm = Record<keyof AddressInput, string>;
const emptyAddress: AddressForm = { recipient: '', phone: '', line1: '', line2: '', city: '', state: '' };

export function CheckoutPage() {
  const { customer, loading } = useCustomer();
  const items = useCart();
  if (loading) return <Skeleton className="mx-auto my-8 h-96 max-w-4xl" />;
  if (!customer) return <Navigate to="/account/login?next=/checkout" replace />;
  if (items.length === 0) return <Navigate to="/cart" replace />;
  return <Checkout name={customer.name} phone={customer.phone ?? ''} />;
}

function Checkout({ name, phone }: { name: string; phone: string }) {
  const navigate = useNavigate();
  const items = useCart();
  const info = useStoreInfo();
  const saved = useQuery({
    queryKey: ['store', 'addresses'],
    queryFn: ({ signal }) => api.get<DataEnvelope<StoreAddress[]>>('/addresses', { signal }).then((r) => r.data),
  });
  const [address, setAddress] = useState<AddressForm>({ ...emptyAddress, recipient: name, phone });
  const [saveAddress, setSaveAddress] = useState(true);
  const [shippingMethodId, setShippingMethodId] = useState('');
  const [provider, setProvider] = useState<PaymentProviderCode | ''>('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // One key per checkout page: a double click or a retry after a dropped connection cannot place two orders.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  // The cart is emptied once the customer has left for payment: emptying it here first would bounce them to /cart.
  const placed = useRef(false);
  useEffect(
    () => () => {
      if (placed.current) cart.clear();
    },
    [],
  );
  const quote = useQuote({ ...(shippingMethodId ? { shippingMethodId } : {}), ...(address.state ? { state: address.state } : {}) });
  const q = quote.data;
  const chosen = q?.shippingOptions.find((o) => o.id === shippingMethodId);
  const needsAddress = !chosen?.isPickup;

  const place = useMutation({
    mutationFn: (body: object) => api.post<DataEnvelope<StoreOrder>>('/checkout', body, { headers: { 'Idempotency-Key': idempotencyKey } }).then((r) => r.data),
    onSuccess: (order) => {
      placed.current = true;
      const redirect = order.payment?.redirectUrl;
      navigate(redirect ?? `/account/orders/${order.number}`, { replace: true });
    },
    onError: (e) => setFormError(e.message),
  });

  const submit = () => {
    setFormError(null);
    const next: Partial<Record<string, string>> = {};
    if (!shippingMethodId) next.shippingMethodId = 'Choose a delivery option';
    if (!provider) next.provider = 'Choose how to pay';
    let parsedAddress: AddressInput | undefined;
    if (needsAddress) {
      const parsed = addressSchema.safeParse(address);
      if (parsed.success) parsedAddress = parsed.data;
      else for (const issue of parsed.error.issues) next[`address.${String(issue.path[0])}`] ??= issue.message;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    place.mutate({ items: cartPayload(items), shippingMethodId, provider, note, saveAddress, ...(parsedAddress ? { address: parsedAddress } : {}) });
  };
  const field = (k: keyof AddressForm) => ({
    value: address[k],
    onChange: (e: { target: { value: string } }) => setAddress((a) => ({ ...a, [k]: e.target.value })),
  });

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Checkout</h1>
        {formError && <Alert variant="destructive">{formError}</Alert>}
        <Card>
          <CardHeader>
            <CardTitle>Delivery address</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {saved.data && saved.data.length > 0 && (
              <Field id="co-saved" label="Saved addresses" className="sm:col-span-2">
                <Select
                  defaultValue=""
                  onChange={(e) => {
                    const a = saved.data.find((s) => s.id === e.target.value);
                    if (a) setAddress({ recipient: a.recipient, phone: a.phone, line1: a.line1, line2: a.line2 ?? '', city: a.city, state: a.state });
                  }}
                >
                  <option value="">Choose a saved address…</option>
                  {saved.data.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.line1}, {a.city}, {a.state}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field id="co-recipient" label="Recipient" error={errors['address.recipient']}>
              <Input autoComplete="name" {...field('recipient')} />
            </Field>
            <Field id="co-phone" label="Phone" error={errors['address.phone']}>
              <Input type="tel" autoComplete="tel" {...field('phone')} />
            </Field>
            <Field id="co-line1" label="Street address" error={errors['address.line1']} className="sm:col-span-2">
              <Input autoComplete="address-line1" {...field('line1')} />
            </Field>
            <Field id="co-line2" label="Apartment, landmark (optional)" className="sm:col-span-2">
              <Input autoComplete="address-line2" {...field('line2')} />
            </Field>
            <Field id="co-city" label="City / town" error={errors['address.city']}>
              <Input autoComplete="address-level2" {...field('city')} />
            </Field>
            <Field id="co-state" label="State" error={errors['address.state']}>
              <Select {...field('state')}>
                <option value="">Choose…</option>
                {NIGERIAN_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} /> Save this address for next time
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Delivery</CardTitle>
          </CardHeader>
          <CardContent>
            <fieldset aria-describedby={errors.shippingMethodId ? 'co-ship-error' : undefined} className="grid gap-2">
              <legend className="sr-only">Delivery option</legend>
              {!address.state && <p className="text-sm text-muted-foreground">Choose your state to see every delivery option.</p>}
              {q?.shippingOptions.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary">
                  <input type="radio" name="shipping" value={o.id} checked={shippingMethodId === o.id} onChange={() => setShippingMethodId(o.id)} className="mt-1" />
                  <span className="flex-1">
                    <span className="font-medium">{o.name}</span>
                    {o.description && <span className="block text-sm text-muted-foreground">{o.description}</span>}
                  </span>
                  <span className="tabular-nums">{o.feeForCart === '0.00' ? 'Free' : formatMoney(o.feeForCart)}</span>
                </label>
              ))}
              {errors.shippingMethodId && (
                <p id="co-ship-error" role="alert" className="text-xs font-medium text-destructive">
                  {errors.shippingMethodId}
                </p>
              )}
              {chosen?.isPickup && <p className="text-sm text-muted-foreground">No delivery address is needed for collection.</p>}
            </fieldset>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {info.data?.providers.map((p) => (
              <label key={p.code} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary">
                <input type="radio" name="provider" value={p.code} checked={provider === p.code} onChange={() => setProvider(p.code)} className="mt-1" />
                <span>
                  <span className="font-medium">{p.name}</span>
                  <span className="block text-sm text-muted-foreground">{p.description}</span>
                </span>
              </label>
            ))}
            {errors.provider && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {errors.provider}
              </p>
            )}
            <Field id="co-note" label="Note for the store (optional)">
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </CardContent>
        </Card>
      </div>

      <aside aria-label="Order summary" className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!q && <Skeleton className="h-32 w-full" />}
            {q && (
              <>
                <ul className="space-y-1">
                  {q.lines.map((l) => (
                    <li key={l.variantId} className="flex justify-between gap-2">
                      <span>
                        {l.productName} × {Number(l.qty)}
                        {l.problem && <span className="block text-xs text-destructive">{PROBLEM_TEXT[l.problem]}</span>}
                      </span>
                      <span className="tabular-nums">{formatMoney(l.total)}</span>
                    </li>
                  ))}
                </ul>
                <dl className="grid grid-cols-2 gap-1 border-t pt-3">
                  <dt className="text-muted-foreground">Items</dt>
                  <dd className="text-right tabular-nums">{formatMoney(q.itemsTotal)}</dd>
                  <dt className="text-muted-foreground">Delivery</dt>
                  <dd className="text-right tabular-nums">{q.shipping ? formatMoney(q.shipping.fee) : '—'}</dd>
                  <dt className="text-muted-foreground">VAT {q.pricesIncludeTax ? '(included)' : ''}</dt>
                  <dd className="text-right tabular-nums">{formatMoney(q.taxTotal)}</dd>
                  <dt className="font-semibold">Total</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatMoney(q.total)}</dd>
                </dl>
              </>
            )}
            <Button className="w-full" disabled={place.isPending || !q || q.lines.some((l) => l.problem)} onClick={submit}>
              {place.isPending ? 'Placing order…' : 'Place order'}
            </Button>
            <p className="text-xs text-muted-foreground">Items are held for you while you pay.</p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
