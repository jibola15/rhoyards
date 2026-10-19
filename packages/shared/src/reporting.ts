import { z } from 'zod';
import { dateInput } from './inputs';

// ── Dashboard ─────────────────────────────────────────────────────────────

export interface DashboardData {
  asOf: string;
  today: { salesCount: number; salesTotal: string; onlineOrders: number };
  monthToDate: { from: string; netSales: string; grossProfit: string; netProfit: string; grossMargin: string | null };
  balances: {
    cash: string;
    cashAccounts: { id: string; code: string; name: string; balance: string }[];
    receivables: string;
    payables: string;
    inventory: string;
  };
  /** Net sales per business day (ledger revenue less returns and discounts), last 30 days, oldest first. */
  dailySales: { date: string; netSales: string; sales: number }[];
  topProducts: { variantId: string; sku: string; name: string; qty: string; netSales: string }[];
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

export const SALES_GROUPS = ['day', 'product', 'category', 'brand', 'cashier', 'channel', 'location'] as const;
export type SalesGroup = (typeof SALES_GROUPS)[number];
export const SALES_GROUP_LABELS: Record<SalesGroup, string> = {
  day: 'Day',
  product: 'Product',
  category: 'Category',
  brand: 'Brand',
  cashier: 'Cashier',
  channel: 'Channel',
  location: 'Location',
};

export const salesReportQuerySchema = z.object({ ...range, groupBy: z.enum(SALES_GROUPS).default('day') });
export const periodReportQuerySchema = z.object(range);
export const stockReportQuerySchema = z.object({
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
  rows: StockReportRow[];
  totals: { onHand: string; value: string };
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
