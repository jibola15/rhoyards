import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { Ban, Clock, PauseCircle, Percent, Printer, Trash2, UserRound, X } from 'lucide-react';
import { moneyString, type DataEnvelope, type PosContext, type SaleDetail, type ShiftSummary, type SuspendedCart } from '@rhoyards/shared';
import {
  Alert,
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { EmptyState, PageHeader, QueryError } from '../../components/page';
import { VariantPicker } from '../../components/VariantPicker';
import { api } from '../../lib/api';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useCustomerSearch, usePosContext, useRefreshPos, useSuspendedSales } from './api';
import { addLine, cartTotals, emptyCart, lineFromVariant, linesFromSuspended, saleBody, type Cart, type CartLine } from './cart';
import { PaymentDialog } from './PaymentDialog';

export function PosPage() {
  const context = usePosContext();
  if (context.isError) return <QueryError error={context.error} onRetry={() => void context.refetch()} />;
  if (context.isPending) return <Skeleton className="h-[32rem] w-full" />;
  const ctx = context.data;
  return ctx.myShift ? <Till ctx={ctx} shift={ctx.myShift} /> : <OpenShift ctx={ctx} />;
}

// ── Opening a shift ──────────────────────────────────────────────────────

function OpenShift({ ctx }: { ctx: PosContext }) {
  const { can } = useAuth();
  const refresh = useRefreshPos();
  const free = ctx.registers.filter((r) => !r.openShift);
  const [registerId, setRegisterId] = useState(free[0]?.id ?? '');
  const [float, setFloat] = useState('0.00');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => api.post('/pos/shifts/open', { registerId, openingFloat: float.trim() }),
    onSuccess: async () => {
      toast.success('Shift opened');
      await refresh();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Point of sale" description="Open a shift on a till to start selling." />
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Open a shift</CardTitle>
        </CardHeader>
        <CardContent>
          {!can('pos.shift.manage') ? (
            <Alert>You do not have permission to open a shift. Ask a supervisor.</Alert>
          ) : ctx.registers.length === 0 ? (
            <Alert>No tills are set up for your location. A manager can add one under Settings → Tills.</Alert>
          ) : (
            <form
              className="grid gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                mutation.mutate();
              }}
            >
              {error && <Alert variant="destructive">{error}</Alert>}
              <Field id="shift-register" label="Till">
                <Select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
                  {ctx.registers.map((r) => (
                    <option key={r.id} value={r.id} disabled={Boolean(r.openShift)}>
                      {r.name} — {r.location.name}
                      {r.openShift ? ` (in use by ${r.openShift.cashier})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="shift-float" label="Opening cash float" description="Cash in the drawer before the first sale.">
                <Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} />
              </Field>
              <div>
                <Button type="submit" disabled={!registerId || mutation.isPending}>
                  {mutation.isPending ? 'Opening…' : 'Open shift'}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── The till ─────────────────────────────────────────────────────────────

function Till({ ctx, shift }: { ctx: PosContext; shift: ShiftSummary }) {
  const { can } = useAuth();
  const refresh = useRefreshPos();
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [paying, setPaying] = useState(false);
  const [discountLine, setDiscountLine] = useState<number | null>(null);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [done, setDone] = useState<SaleDetail | null>(null);
  const totals = useMemo(() => cartTotals(cart.lines, ctx.pricing.pricesIncludeTax, ctx.pricing.vatRegistered), [cart.lines, ctx.pricing]);
  const registerId = shift.register.id;
  const parked = useSuspendedSales(registerId);
  const canOverridePrice = can('pos.price.override');
  const canDiscount = can('pos.discount') || can('pos.discount.override');

  const setLine = (i: number, patch: Partial<CartLine>) => setCart((c) => ({ ...c, lines: c.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const removeLine = (i: number) => setCart((c) => ({ ...c, lines: c.lines.filter((_, j) => j !== i) }));

  const park = useMutation({
    mutationFn: () => api.post('/pos/sales/suspend', saleBody(registerId, cart)),
    onSuccess: async () => {
      setCart(emptyCart());
      toast.success('Sale parked');
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const ready = cart.lines.length > 0 && totals.ok;
  const total = totals.ok ? moneyString(totals.priced.total) : '0.00';

  // F9 opens payment, the usual till shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F9' && ready) {
        e.preventDefault();
        setPaying(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Point of sale</h1>
          <p className="text-sm text-muted-foreground">
            {shift.register.name} · Shift {shift.number} · opened {formatDateTime(shift.openedAt)} · {ctx.pricing.pricesIncludeTax ? 'Prices include VAT' : 'VAT added at checkout'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setParkedOpen(true)}>
            <Clock />
            Parked sales{parked.data && parked.data.length > 0 ? ` (${parked.data.length})` : ''}
          </Button>
          <Link to={`/pos/shifts/${shift.id}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Shift &amp; close
          </Link>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardContent className="space-y-4 pt-5">
            <VariantPicker
              captureScans
              autoFocus
              label="Scan or search a product"
              placeholder="Scan a barcode, or type a name or SKU"
              locationId={shift.register.locationId}
              onSelect={(v) => setCart((c) => ({ ...c, lines: addLine(c.lines, lineFromVariant(v)) }))}
            />
            {cart.lines.length === 0 ? (
              <EmptyState title="The cart is empty">Scan an item or search for it above.</EmptyState>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="w-24">Qty</TableHead>
                    <TableHead className="w-32 text-right">Price</TableHead>
                    <TableHead className="w-32 text-right">Total</TableHead>
                    <TableHead className="w-20">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.lines.map((l, i) => {
                    const priced = totals.ok ? totals.priced.lines[i] : undefined;
                    const invalid = !totals.ok && totals.line === i + 1;
                    return (
                      <TableRow key={`${l.variantId}-${i}`}>
                        <TableCell>
                          <div className="font-medium">{l.description}</div>
                          <div className="font-mono text-xs text-muted-foreground">{l.sku}</div>
                          {l.discount && priced && (
                            <Badge variant="secondary" className="mt-1">
                              −{formatMoney(moneyString(priced.discount))}
                              {l.discount.type === 'percent' ? ` (${l.discount.value}%)` : ''}
                            </Badge>
                          )}
                          {l.unitPrice !== l.listPrice && (
                            <Badge variant="outline" className="ml-1 mt-1">
                              Price changed from {formatMoney(l.listPrice)}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={`Quantity of ${l.description}`}
                            inputMode={l.allowsFraction ? 'decimal' : 'numeric'}
                            value={l.qty}
                            aria-invalid={invalid || undefined}
                            onChange={(e) => setLine(i, { qty: e.target.value.trim() })}
                            onFocus={(e) => e.target.select()}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {canOverridePrice ? (
                            <Input aria-label={`Price of ${l.description}`} inputMode="decimal" className="text-right" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value.trim() })} />
                          ) : (
                            <span className="tabular-nums">{formatMoney(l.unitPrice)}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{priced ? formatMoney(moneyString(priced.total)) : '—'}</TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            {canDiscount && (
                              <Button variant="ghost" size="icon" aria-label={`Discount ${l.description}`} onClick={() => setDiscountLine(i)}>
                                <Percent />
                              </Button>
                            )}
                            <Button variant="ghost" size="icon" aria-label={`Remove ${l.description}`} onClick={() => removeLine(i)}>
                              <Trash2 />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {!totals.ok && cart.lines.length > 0 && <Alert variant="destructive">{totals.error}</Alert>}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-5">
              <CustomerPicker value={cart.customer} onChange={(customer) => setCart((c) => ({ ...c, customer }))} />
              <dl className="grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Items</dt>
                <dd className="text-right tabular-nums">{cart.lines.length}</dd>
                {totals.ok && totals.priced.discountTotal.gt(0) && (
                  <>
                    <dt className="text-muted-foreground">Discounts</dt>
                    <dd className="text-right tabular-nums">−{formatMoney(moneyString(totals.priced.discountTotal))}</dd>
                  </>
                )}
                {ctx.pricing.vatRegistered && totals.ok && (
                  <>
                    <dt className="text-muted-foreground">{ctx.pricing.pricesIncludeTax ? 'Net of VAT' : 'Subtotal'}</dt>
                    <dd className="text-right tabular-nums">{formatMoney(moneyString(totals.priced.subtotal))}</dd>
                    <dt className="text-muted-foreground">{ctx.pricing.pricesIncludeTax ? 'VAT included' : 'VAT'}</dt>
                    <dd className="text-right tabular-nums">{formatMoney(moneyString(totals.priced.taxTotal))}</dd>
                  </>
                )}
                <dt className="pt-2 text-lg font-semibold">Total</dt>
                <dd className="pt-2 text-right text-2xl font-semibold tabular-nums" aria-live="polite" data-testid="cart-total">
                  {formatMoney(total)}
                </dd>
              </dl>
              <Field id="sale-note" label="Note (optional)">
                <Textarea rows={2} value={cart.note} onChange={(e) => setCart((c) => ({ ...c, note: e.target.value }))} />
              </Field>
              <Button className="h-12 w-full text-base" disabled={!ready} onClick={() => setPaying(true)}>
                Pay {formatMoney(total)} <span className="text-xs opacity-70">(F9)</span>
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" disabled={cart.lines.length === 0 || park.isPending} onClick={() => park.mutate()}>
                  <PauseCircle />
                  Park
                </Button>
                <Button variant="outline" disabled={cart.lines.length === 0 && !cart.customer} onClick={() => setCart(emptyCart())}>
                  <Ban />
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>
          <ShiftCard shift={shift} />
        </div>
      </div>

      <PaymentDialog
        open={paying}
        onOpenChange={setPaying}
        total={total}
        body={saleBody(registerId, cart)}
        methods={ctx.paymentMethods}
        customer={cart.customer}
        canCredit={can('pos.credit_sale')}
        onComplete={(sale) => {
          setPaying(false);
          setCart(emptyCart());
          setDone(sale);
          void refresh();
        }}
      />
      {discountLine !== null && cart.lines[discountLine] && (
        <DiscountDialog
          line={cart.lines[discountLine]}
          maxPercent={ctx.pricing.maxDiscountPercent}
          canOverride={can('pos.discount.override')}
          onClose={() => setDiscountLine(null)}
          onApply={(discount) => {
            setLine(discountLine, { discount });
            setDiscountLine(null);
          }}
        />
      )}
      <ParkedSalesDialog
        open={parkedOpen}
        onOpenChange={setParkedOpen}
        registerId={registerId}
        cartBusy={cart.lines.length > 0}
        onResume={(c) => {
          setCart({ lines: linesFromSuspended(c), customer: c.customer, note: c.note ?? '' });
          setParkedOpen(false);
          void refresh();
        }}
      />
      <SaleDoneDialog sale={done} onClose={() => setDone(null)} />
    </div>
  );
}

function ShiftCard({ shift }: { shift: ShiftSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">This shift</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Sales</dt>
          <dd className="text-right tabular-nums">{shift.salesCount}</dd>
          <dt className="text-muted-foreground">Takings</dt>
          <dd className="text-right tabular-nums">{formatMoney(shift.salesTotal)}</dd>
          <dt className="text-muted-foreground">Expected cash in drawer</dt>
          <dd className="text-right tabular-nums">{formatMoney(shift.expectedCash)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

// ── Customer ─────────────────────────────────────────────────────────────

function CustomerPicker({ value, onChange }: { value: Cart['customer']; onChange: (c: Cart['customer']) => void }) {
  const { can } = useAuth();
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 250);
  const results = useCustomerSearch(q, can('customers.view') && q.length >= 2);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
        <span className="flex items-center gap-2">
          <UserRound className="size-4" aria-hidden="true" />
          <span>
            <span className="font-medium">{value.name}</span>
            {value.allowCredit && <span className="block text-xs text-muted-foreground">Credit account</span>}
          </span>
        </span>
        <Button variant="ghost" size="icon" aria-label="Remove customer" onClick={() => onChange(null)}>
          <X />
        </Button>
      </div>
    );
  }
  if (!can('customers.view')) return <p className="text-sm text-muted-foreground">Walk-in customer</p>;
  return (
    <div className="relative">
      <Field id="pos-customer" label="Customer (optional)">
        <Input type="search" placeholder="Walk-in — search name or phone" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </Field>
      {q.length >= 2 && results.data && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md" aria-label="Matching customers">
          {results.data.length === 0 && <li className="p-2 text-sm text-muted-foreground">No customers match.</li>}
          {results.data.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onChange({ id: c.id, name: c.name, allowCredit: c.allowCredit });
                  setText('');
                }}
              >
                <span className="font-medium">{c.name}</span> <span className="text-xs text-muted-foreground">{[c.code, c.phone].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────

function DiscountDialog({
  line,
  maxPercent,
  canOverride,
  onApply,
  onClose,
}: {
  line: CartLine;
  maxPercent: string;
  canOverride: boolean;
  onApply: (d: CartLine['discount']) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<'percent' | 'amount'>(line.discount?.type ?? 'percent');
  const [value, setValue] = useState(line.discount?.value ?? '');
  const valid = /^\d+(\.\d{1,2})?$/.test(value.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Discount</DialogTitle>
          <DialogDescription>{line.description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onApply(Number(value) === 0 ? null : { type, value: value.trim() });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field id="disc-type" label="Type">
              <Select value={type} onChange={(e) => setType(e.target.value as 'percent' | 'amount')}>
                <option value="percent">Percent</option>
                <option value="amount">Amount (₦)</option>
              </Select>
            </Field>
            <Field id="disc-value" label={type === 'percent' ? 'Percent' : 'Amount'}>
              <Input inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Up to {maxPercent}% without approval.{!canOverride && ' Larger discounts need a supervisor at payment.'}
          </p>
          <DialogFooter>
            {line.discount && (
              <Button type="button" variant="outline" onClick={() => onApply(null)}>
                Remove discount
              </Button>
            )}
            <Button type="submit" disabled={!valid}>
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ParkedSalesDialog({
  open,
  onOpenChange,
  registerId,
  cartBusy,
  onResume,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  registerId: string;
  cartBusy: boolean;
  onResume: (cart: SuspendedCart) => void;
}) {
  const parked = useSuspendedSales(registerId);
  const resume = useMutation({
    mutationFn: (id: string) => api.post<DataEnvelope<SuspendedCart>>(`/pos/sales/${id}/resume`),
    onSuccess: (res) => onResume(res.data),
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Parked sales</DialogTitle>
          <DialogDescription>Sales put on hold at this till. Stock is not taken until the sale is completed.</DialogDescription>
        </DialogHeader>
        {cartBusy && <Alert>Finish, park or clear the current sale before resuming another.</Alert>}
        {parked.isError && <QueryError error={parked.error} onRetry={() => void parked.refetch()} />}
        {parked.data?.length === 0 && <EmptyState title="No parked sales" />}
        <ul className="divide-y">
          {parked.data?.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <span className="font-medium">{formatMoney(s.total)}</span> · {s.itemCount} item{s.itemCount === 1 ? '' : 's'}
                {s.customer && ` · ${s.customer.name}`}
                <span className="block text-xs text-muted-foreground">
                  {formatDateTime(s.createdAt)} by {s.cashier}
                </span>
              </span>
              <Button size="sm" disabled={cartBusy || resume.isPending} onClick={() => resume.mutate(s.id)}>
                Resume
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function SaleDoneDialog({ sale, onClose }: { sale: SaleDetail | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(sale)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        {sale && (
          <>
            <DialogHeader>
              <DialogTitle>Sale {sale.number} complete</DialogTitle>
              <DialogDescription>Total {formatMoney(sale.total)}</DialogDescription>
            </DialogHeader>
            {Number(sale.changeGiven) > 0 && (
              <p className="rounded-md bg-muted p-4 text-center text-2xl font-semibold" role="status">
                Change: {formatMoney(sale.changeGiven)}
              </p>
            )}
            {Number(sale.balanceDue) > 0 && <p className="text-sm">{formatMoney(sale.balanceDue)} added to {sale.customer?.name}'s account.</p>}
            <DialogFooter>
              <a href={`/sales/${sale.id}/receipt`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline' })}>
                <Printer />
                Print receipt
              </a>
              <Button autoFocus onClick={onClose}>
                New sale
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
