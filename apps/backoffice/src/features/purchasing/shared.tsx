import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import type { Decimal } from '@rhoyards/shared';
import { Skeleton } from '@rhoyards/ui';
import { PageHeader, QueryError } from '../../components/page';
import { formatMoney } from '../../lib/format';

/** Back link + title + loading/error handling shared by the purchasing document pages. */
export function DocumentShell({
  back,
  title,
  isNew,
  query,
  children,
}: {
  back: { to: string; label: string };
  title: string;
  isNew: boolean;
  query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown };
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to={back.to} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> {back.label}
      </Link>
      <PageHeader title={title} />
      {!isNew && query.isPending && <Skeleton className="h-64 w-full" />}
      {!isNew && query.isError && query.error && <QueryError error={query.error} onRetry={() => void query.refetch()} />}
      {children}
    </div>
  );
}

export function TotalsBox({ subtotal, tax, total }: { subtotal: Decimal | string; tax: Decimal | string; total: Decimal | string }) {
  const f = (v: Decimal | string) => formatMoney(typeof v === 'string' ? v : v.toFixed(2));
  return (
    <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm">
      <dt className="text-muted-foreground">Subtotal</dt>
      <dd className="text-right tabular-nums">{f(subtotal)}</dd>
      <dt className="text-muted-foreground">VAT</dt>
      <dd className="text-right tabular-nums">{f(tax)}</dd>
      <dt className="font-medium">Total</dt>
      <dd className="text-right font-semibold tabular-nums">{f(total)}</dd>
    </dl>
  );
}

export function InfoGrid({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-4 text-sm sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
