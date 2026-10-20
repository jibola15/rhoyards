import { Link, useParams } from 'react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { dec, moneyString, type ReceiptData } from '@rhoyards/shared';
import { Button, buttonVariants, Skeleton } from '@rhoyards/ui';
import { QueryError } from '../../components/page';
import { formatDateTime, formatMoney, formatQty } from '../../lib/format';
import { useReceipt } from './api';

/** An 80 mm till receipt. Amounts come from the stored sale, never recalculated. */
export function Receipt({ data }: { data: ReceiptData }) {
  const { business, store, sale } = data;
  const row = (label: string, value: string, strong = false) => (
    <div className={strong ? 'flex justify-between font-bold' : 'flex justify-between'}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
  return (
    <article aria-label={`Receipt ${sale.number}`} className="mx-auto w-full max-w-[80mm] bg-white p-3 font-mono text-[12px] leading-snug text-black">
      <header className="text-center">
        <h1 className="text-sm font-bold">{business.name}</h1>
        {store.name && store.name !== business.name && <p>{store.name}</p>}
        {store.address && <p className="whitespace-pre-line">{store.address}</p>}
        {store.phone && <p>Tel: {store.phone}</p>}
        {business.vatRegistered && business.taxId && <p>TIN: {business.taxId}</p>}
        {data.header && <p className="mt-1 whitespace-pre-line">{data.header}</p>}
      </header>
      <hr className="my-2 border-dashed border-black" />
      <p>Receipt: {sale.number}</p>
      <p>{formatDateTime(sale.completedAt)}</p>
      <p>
        {sale.register?.name ?? sale.location.name} · Cashier: {sale.cashier}
      </p>
      {sale.customer && <p>Customer: {sale.customer.name}</p>}
      <hr className="my-2 border-dashed border-black" />
      <ul className="grid gap-1">
        {sale.items.map((i) => (
          <li key={i.id}>
            <div>{i.description}</div>
            <div className="flex justify-between">
              <span>
                {formatQty(i.qty)} × {formatMoney(i.unitPrice)}
              </span>
              <span className="tabular-nums">{formatMoney(moneyString(dec(sale.pricesIncludeTax ? i.lineTotal : i.netAmount).plus(i.discountAmount)))}</span>
            </div>
            {Number(i.discountAmount) > 0 && <div className="pl-2">Discount −{formatMoney(i.discountAmount)}</div>}
          </li>
        ))}
      </ul>
      <hr className="my-2 border-dashed border-black" />
      {Number(sale.discountTotal) > 0 && row('Discounts', `−${formatMoney(sale.discountTotal)}`)}
      {business.vatRegistered && row(sale.pricesIncludeTax ? 'Net (excl. VAT)' : 'Subtotal', formatMoney(sale.subtotal))}
      {business.vatRegistered && row(sale.pricesIncludeTax ? 'VAT included' : 'VAT', formatMoney(sale.taxTotal))}
      {row('TOTAL', formatMoney(sale.total), true)}
      <div className="mt-1">
        {sale.payments.map((p) => (
          <div key={p.id}>
            {row(p.method.name, formatMoney(p.tendered ?? p.amount))}
            {p.reference && <div className="pl-2">Ref: {p.reference}</div>}
          </div>
        ))}
        {Number(sale.changeGiven) > 0 && row('Change', formatMoney(sale.changeGiven))}
        {Number(sale.balanceDue) > 0 && row('On account', formatMoney(sale.balanceDue), true)}
      </div>
      {business.vatRegistered && data.taxSummary.length > 0 && (
        <>
          <hr className="my-2 border-dashed border-black" />
          <table className="w-full">
            <thead>
              <tr>
                <th className="text-left font-normal">VAT rate</th>
                <th className="text-right font-normal">Net</th>
                <th className="text-right font-normal">VAT</th>
              </tr>
            </thead>
            <tbody>
              {data.taxSummary.map((t) => (
                <tr key={t.rate}>
                  <td>{formatQty(t.rate)}%</td>
                  <td className="text-right tabular-nums">{formatMoney(t.net)}</td>
                  <td className="text-right tabular-nums">{formatMoney(t.tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {data.footer && <p className="mt-3 whitespace-pre-line text-center">{data.footer}</p>}
    </article>
  );
}

/** Stand-alone printable receipt (opened from the till or a sale's page). */
export function ReceiptPage() {
  const { id } = useParams();
  const receipt = useReceipt(id);
  return (
    <div className="min-h-screen bg-muted/40 p-4 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-[80mm] justify-between gap-2 print:hidden">
        <Link to={`/sales/${id}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowLeft />
          Sale
        </Link>
        <Button size="sm" onClick={() => window.print()} disabled={!receipt.data}>
          <Printer />
          Print
        </Button>
      </div>
      {receipt.isError && <QueryError error={receipt.error} onRetry={() => void receipt.refetch()} />}
      {receipt.isPending && <Skeleton className="mx-auto h-96 max-w-[80mm]" />}
      {receipt.data && <Receipt data={receipt.data} />}
    </div>
  );
}
