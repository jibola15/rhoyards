import { z } from 'zod';
import { dateInput } from './inputs';

// ── Dashboard ─────────────────────────────────────────────────────────────

export const DASHBOARD_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_30_days',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  last_30_days: 'Last 30 days',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  this_year: 'This year',
  last_year: 'Last year',
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const shift = (iso: string, days: number) => {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};
const monthStart = (y: number, m: number) => isoDay(new Date(Date.UTC(y, m, 1)));
const monthEnd = (y: number, m: number) => isoDay(new Date(Date.UTC(y, m + 1, 0)));

/**
 * The business dates a dashboard period covers, inclusive. `today` is the business date. Weeks start on Monday;
 * periods still running ("this …") end today.
 */
export function dashboardPeriodRange(period: DashboardPeriod, today: string): { from: string; to: string } {
  const t = utc(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const weekday = (t.getUTCDay() + 6) % 7; // Monday = 0
  const q = Math.floor(m / 3) * 3;
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shift(today, -1), to: shift(today, -1) };
    case 'this_week':
      return { from: shift(today, -weekday), to: today };
    case 'last_week':
      return { from: shift(today, -weekday - 7), to: shift(today, -weekday - 1) };
    case 'this_month':
      return { from: monthStart(y, m), to: today };
    case 'last_month':
      return { from: monthStart(y, m - 1), to: monthEnd(y, m - 1) };
    case 'last_30_days':
      return { from: shift(today, -29), to: today };
    case 'this_quarter':
      return { from: monthStart(y, q), to: today };
    case 'last_quarter':
      return { from: monthStart(y, q - 3), to: monthEnd(y, q - 1) };
    case 'this_year':
      return { from: monthStart(y, 0), to: today };
    case 'last_year':
      return { from: monthStart(y - 1, 0), to: monthEnd(y - 1, 11) };
  }
}

export interface DashboardData {
  asOf: string;
  /** The dates the sales, profit, chart and best sellers cover (inclusive). */
  period: { key: DashboardPeriod; label: string; from: string; to: string };
  /** The stores the figures are for (one chosen store, or the person's own stores); null for the whole business. */
  stores: { ids: string[]; label: string } | null;
  /** Completed sales in the period (VAT-inclusive totals) and online orders placed. */
  sales: { count: number; total: string; onlineOrders: number };
  /** For one store, net profit is null: expenses are not recorded per store. */
  profit: { netSales: string; grossProfit: string; netProfit: string | null; grossMargin: string | null };
  /** As of now, whatever the period; always the whole business (one set of bank accounts and books). */
  balances: {
    cash: string;
    cashAccounts: { id: string; code: string; name: string; balance: string }[];
    receivables: string;
    payables: string;
    inventory: string;
  };
  /**
   * Net sales (ledger revenue less returns and discounts) per day, or per month for periods over three months,
   * oldest first. A one-day period shows the seven days up to it. `date` is the day or the month's first day.
   */
  series: { bucket: 'day' | 'month'; from: string; to: string; points: { date: string; netSales: string; sales: number }[] };
  topProducts: { variantId: string; sku: string; name: string; qty: string; netSales: string }[];
  /** As of now, whatever the period. */
  attention: {
    lowStock: number;
    outOfStock: number;
    expiringSoon: number;
    ordersAwaitingPayment: number;
    ordersToFulfil: number;
    ordersOnHold: number;
    returnsToApprove: number;
    expensesToApprove: number;
  };
}

// ── Operational reports ───────────────────────────────────────────────────

const range = { from: dateInput.optional(), to: dateInput.optional(), format: z.enum(['json', 'csv']).default('json') };

export const SALES_GROUPS = ['day', 'product', 'category', 'brand', 'cashier', 'channel', 'location', 'customer'] as const;
export type SalesGroup = (typeof SALES_GROUPS)[number];
export const SALES_GROUP_LABELS: Record<SalesGroup, string> = {
  day: 'Day',
  product: 'Product',
  category: 'Category',
  brand: 'Brand',
  cashier: 'Cashier',
  channel: 'Channel',
  location: 'Location',
  customer: 'Customer',
};

/** Optional: one store's figures (staff assigned to stores see only theirs). */
const store = { locationId: z.uuid().optional() };

export const dashboardQuerySchema = z.object({ ...store, period: z.enum(DASHBOARD_PERIODS).default('this_month') });
export const salesReportQuerySchema = z.object({ ...range, ...store, groupBy: z.enum(SALES_GROUPS).default('day') });
export const periodReportQuerySchema = z.object({ ...range, ...store });
export const stockReportQuerySchema = z.object({
  ...store,
  /** Sales over this many days set the rate of sale (days of cover). */
  days: z.coerce.number().int().min(7).max(365).default(90),
  status: z.enum(['all', 'low', 'out', 'slow']).default('all'),
  format: z.enum(['json', 'csv']).default('json'),
});

export interface SalesReportRow {
  key: string;
  label: string;
  /** SKU when grouped by product. */
  code: string | null;
  sales: number;
  qtySold: string;
  qtyReturned: string;
  /** Item revenue net of VAT and discounts, less returns. */
  netSales: string;
  tax: string;
  cost: string;
  grossProfit: string;
  margin: string | null;
}

export interface SalesReport {
  from: string;
  to: string;
  groupBy: SalesGroup;
  rows: SalesReportRow[];
  totals: Omit<SalesReportRow, 'key' | 'label' | 'code'>;
}

export interface PaymentsReport {
  from: string;
  to: string;
  rows: { methodId: string; method: string; kind: string; sales: string; receipts: string; refunds: string; net: string }[];
  totals: { sales: string; receipts: string; refunds: string; net: string };
}

export interface ExpensesReport {
  from: string;
  to: string;
  rows: { categoryId: string; category: string; count: number; net: string; tax: string; total: string }[];
  totals: { count: number; net: string; tax: string; total: string };
}

export interface StockReportRow {
  variantId: string;
  sku: string;
  product: string;
  variant: string;
  onHand: string;
  reserved: string;
  avgCost: string;
  value: string;
  reorderLevel: string;
  soldInPeriod: string;
  /** On-hand ÷ daily rate of sale; null when nothing sold. */
  daysOfCover: number | null;
  status: 'OK' | 'LOW' | 'OUT' | 'SLOW';
}

export interface StockReport {
  days: number;
  /** The stores covered, in the order of each row's `byStore` (empty when the report covers one store). */
  stores: { id: string; name: string }[];
  rows: (StockReportRow & { byStore: string[] })[];
  totals: { onHand: string; value: string; byStore: string[] };
}

// ── Items bought per customer ─────────────────────────────────────────────

export const customerItemsQuerySchema = z.object({
  ...range,
  ...store,
  /** One customer; else every customer who bought in the period (walk-in sales left out). */
  customerId: z.uuid().optional(),
});

export interface CustomerItemsRow {
  customerId: string;
  customer: string;
  customerCode: string;
  variantId: string;
  sku: string;
  product: string;
  qtySold: string;
  qtyReturned: string;
  /** Net of VAT and discounts, less returns. */
  netSales: string;
  /** Including VAT: what the customer paid for the items. */
  total: string;
  lastBought: string | null;
}

export interface CustomerItemsReport {
  from: string;
  to: string;
  /** Sorted by customer, then by net sales. */
  rows: CustomerItemsRow[];
  customers: { customerId: string; customer: string; customerCode: string; qtySold: string; netSales: string; total: string }[];
  totals: { qtySold: string; qtyReturned: string; netSales: string; total: string };
}

// ── Item ledger ───────────────────────────────────────────────────────────

export const itemLedgerQuerySchema = z.object({
  variantId: z.uuid(),
  ...range,
  ...store,
});

export interface ItemLedgerLine {
  id: string;
  at: string;
  type: string;
  location: string;
  lotNumber: string | null;
  qtyIn: string;
  qtyOut: string;
  /** Running quantity: at the store, or business-wide. */
  balance: string;
  unitCost: string;
  /** Signed value moved, at cost. */
  value: string;
  sourceType: string;
  sourceId: string;
  reference: string | null;
  by: string;
}

export interface ItemLedger {
  from: string;
  to: string;
  item: { variantId: string; sku: string; product: string; variant: string; avgCost: string };
  /** Null for the whole business. */
  store: { id: string; name: string } | null;
  opening: { qty: string; value: string };
  lines: ItemLedgerLine[];
  totals: { qtyIn: string; qtyOut: string; value: string };
  closing: { qty: string; value: string };
}

// ── Customer ledger ───────────────────────────────────────────────────────

export const customerLedgerQuerySchema = z.object({ customerId: z.uuid(), ...range });

export interface CustomerLedgerLine {
  date: string;
  type: 'SALE' | 'RECEIPT' | 'RETURN';
  id: string;
  number: string;
  /** Store of the sale or return; null for a payment on account. */
  location: string | null;
  description: string;
  /** Sale value (sale), or refund paid out (return). */
  debit: string;
  /** Paid at the till or on account, or value returned. */
  credit: string;
  /** Running amount owed (negative: in credit). */
  balance: string;
}

export interface CustomerLedger {
  from: string;
  to: string;
  customer: { id: string; code: string; name: string; phone: string | null; creditLimit: string; allowCredit: boolean };
  openingBalance: string;
  lines: CustomerLedgerLine[];
  /** In the period: sales value, paid at the till and on account, value of returns, and refunds paid out. */
  totals: { purchases: string; payments: string; returns: string; refunds: string };
  closingBalance: string;
}

// ── Audit log ─────────────────────────────────────────────────────────────

export interface AuditLogRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; fullName: string; email: string } | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}
