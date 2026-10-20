import { Router, type Request } from 'express';
import {
  dashboardQuerySchema,
  periodReportQuerySchema,
  SALES_GROUP_LABELS,
  salesReportQuerySchema,
  stockReportQuerySchema,
  type ExpensesReport,
  type PaymentsReport,
  type SalesReportRow,
  type StockReportRow,
} from '@rhoyards/shared';
import { sendCsv, type CsvColumn } from '../../lib/csv';
import { getPrisma } from '../../lib/prisma';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { assertLocationAccess, locationScope } from '../auth/location-scope';
import { getDashboard } from './dashboard.service';
import { expensesReport, paymentsReport, salesReport, stockReport } from './operational.service';

/** Expenses are not recorded per store. */
const expensesQuerySchema = periodReportQuerySchema.omit({ locationId: true });

/**
 * Which stores a report covers: the store asked for, else the person's own stores, else the whole business (null).
 * Sales figures are limited to the person's stores; stock may be looked up at any store (to arrange transfers).
 */
async function reportStores(req: Request, locationId: string | undefined, anyStore = false): Promise<{ ids: string[]; label: string } | null> {
  const ids = locationId ? [locationId] : locationScope(req.auth);
  if (!ids) return null;
  if (locationId && !anyStore) assertLocationAccess(req.auth, locationId);
  const names = await getPrisma().location.findMany({ where: { id: { in: ids } }, select: { name: true }, orderBy: { name: 'asc' } });
  return { ids, label: names.map((n) => n.name).join(', ') };
}

const docs: [string, string, Parameters<typeof registry.registerPath>[0]['request']][] = [
  ['/dashboard', 'Management dashboard: today, month to date, balances, 30-day sales, attention items; ?locationId= for one store (dashboard.view)', { query: dashboardQuerySchema }],
  ['/reports/sales', 'Sales by day, product, category, brand, cashier, channel or location; ?format=csv (reports.sales)', { query: salesReportQuerySchema }],
  ['/reports/payments', 'Money taken and refunded by payment method; ?format=csv (reports.sales or reports.financial)', { query: periodReportQuerySchema }],
  ['/reports/expenses', 'Posted expenses by category, whole business; ?format=csv (reports.financial or expenses.view)', { query: expensesQuerySchema }],
  ['/reports/stock', 'Stock on hand, value, rate of sale and status; ?format=csv (reports.inventory or inventory.view)', { query: stockReportQuerySchema }],
];
for (const [path, summary, request] of docs) {
  registry.registerPath({ method: 'get', path, tags: ['Reports'], summary, ...(request ? { request } : {}), responses: { 200: { description: 'Report (JSON or CSV)' } } });
}

const salesColumns = (groupBy: keyof typeof SALES_GROUP_LABELS): CsvColumn<SalesReportRow>[] => [
  { header: SALES_GROUP_LABELS[groupBy], value: (r) => r.label },
  ...(groupBy === 'product' ? [{ header: 'SKU', value: (r: SalesReportRow) => r.code }] : []),
  { header: 'Sales', value: (r) => r.sales },
  { header: 'Qty sold', value: (r) => r.qtySold },
  { header: 'Qty returned', value: (r) => r.qtyReturned },
  { header: 'Net sales', value: (r) => r.netSales },
  { header: 'VAT', value: (r) => r.tax },
  { header: 'Cost', value: (r) => r.cost },
  { header: 'Gross profit', value: (r) => r.grossProfit },
  { header: 'Margin %', value: (r) => r.margin },
];
const paymentColumns: CsvColumn<PaymentsReport['rows'][number]>[] = [
  { header: 'Payment method', value: (r) => r.method },
  { header: 'Sales', value: (r) => r.sales },
  { header: 'Customer payments', value: (r) => r.receipts },
  { header: 'Refunds', value: (r) => r.refunds },
  { header: 'Net', value: (r) => r.net },
];
const expenseColumns: CsvColumn<ExpensesReport['rows'][number]>[] = [
  { header: 'Category', value: (r) => r.category },
  { header: 'Expenses', value: (r) => r.count },
  { header: 'Net', value: (r) => r.net },
  { header: 'VAT', value: (r) => r.tax },
  { header: 'Total', value: (r) => r.total },
];
const stockColumns: CsvColumn<StockReportRow>[] = [
  { header: 'SKU', value: (r) => r.sku },
  { header: 'Product', value: (r) => r.product },
  { header: 'Variant', value: (r) => r.variant },
  { header: 'On hand', value: (r) => r.onHand },
  { header: 'Reserved', value: (r) => r.reserved },
  { header: 'Average cost', value: (r) => r.avgCost },
  { header: 'Value', value: (r) => r.value },
  { header: 'Reorder level', value: (r) => r.reorderLevel },
  { header: 'Sold in period', value: (r) => r.soldInPeriod },
  { header: 'Days of cover', value: (r) => r.daysOfCover },
  { header: 'Status', value: (r) => r.status },
];

export const reportingRouter = Router();

reportingRouter.get('/dashboard', ...requirePermission('dashboard.view'), async (req, res) => {
  const q = parse(dashboardQuerySchema, req.query);
  res.json({ data: await getDashboard(await reportStores(req, q.locationId)) });
});
reportingRouter.get('/reports/sales', ...requirePermission('reports.sales'), async (req, res) => {
  const q = parse(salesReportQuerySchema, req.query);
  const report = await salesReport({ ...q, stores: (await reportStores(req, q.locationId))?.ids ?? null });
  if (q.format === 'csv') return sendCsv(res, `sales-by-${q.groupBy}-${report.from}-to-${report.to}.csv`, salesColumns(q.groupBy), report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/payments', ...requireAnyPermission('reports.sales', 'reports.financial'), async (req, res) => {
  const q = parse(periodReportQuerySchema, req.query);
  const report = await paymentsReport(q.from, q.to, (await reportStores(req, q.locationId))?.ids ?? null);
  if (q.format === 'csv') return sendCsv(res, `payments-${report.from}-to-${report.to}.csv`, paymentColumns, report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/expenses', ...requireAnyPermission('reports.financial', 'expenses.view'), async (req, res) => {
  const q = parse(expensesQuerySchema, req.query);
  const report = await expensesReport(q.from, q.to);
  if (q.format === 'csv') return sendCsv(res, `expenses-${report.from}-to-${report.to}.csv`, expenseColumns, report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/stock', ...requireAnyPermission('reports.inventory', 'inventory.view'), async (req, res) => {
  const q = parse(stockReportQuerySchema, req.query);
  const report = await stockReport({ ...q, stores: (await reportStores(req, q.locationId, true))?.ids ?? null });
  if (q.format === 'csv') return sendCsv(res, `stock-${q.status}.csv`, stockColumns, report.rows);
  res.json({ data: report });
});
