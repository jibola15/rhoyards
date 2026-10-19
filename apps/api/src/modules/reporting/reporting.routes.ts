import { Router } from 'express';
import {
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
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { getDashboard } from './dashboard.service';
import { expensesReport, paymentsReport, salesReport, stockReport } from './operational.service';

const docs: [string, string, Parameters<typeof registry.registerPath>[0]['request']][] = [
  ['/dashboard', 'Management dashboard: today, month to date, balances, 30-day sales, attention items (dashboard.view)', undefined],
  ['/reports/sales', 'Sales by day, product, category, brand, cashier, channel or location; ?format=csv (reports.sales)', { query: salesReportQuerySchema }],
  ['/reports/payments', 'Money taken and refunded by payment method; ?format=csv (reports.sales or reports.financial)', { query: periodReportQuerySchema }],
  ['/reports/expenses', 'Posted expenses by category; ?format=csv (reports.financial or expenses.view)', { query: periodReportQuerySchema }],
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

reportingRouter.get('/dashboard', ...requirePermission('dashboard.view'), async (_req, res) => {
  res.json({ data: await getDashboard() });
});
reportingRouter.get('/reports/sales', ...requirePermission('reports.sales'), async (req, res) => {
  const q = parse(salesReportQuerySchema, req.query);
  const report = await salesReport(q);
  if (q.format === 'csv') return sendCsv(res, `sales-by-${q.groupBy}-${report.from}-to-${report.to}.csv`, salesColumns(q.groupBy), report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/payments', ...requireAnyPermission('reports.sales', 'reports.financial'), async (req, res) => {
  const q = parse(periodReportQuerySchema, req.query);
  const report = await paymentsReport(q.from, q.to);
  if (q.format === 'csv') return sendCsv(res, `payments-${report.from}-to-${report.to}.csv`, paymentColumns, report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/expenses', ...requireAnyPermission('reports.financial', 'expenses.view'), async (req, res) => {
  const q = parse(periodReportQuerySchema, req.query);
  const report = await expensesReport(q.from, q.to);
  if (q.format === 'csv') return sendCsv(res, `expenses-${report.from}-to-${report.to}.csv`, expenseColumns, report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/stock', ...requireAnyPermission('reports.inventory', 'inventory.view'), async (req, res) => {
  const q = parse(stockReportQuerySchema, req.query);
  const report = await stockReport(q);
  if (q.format === 'csv') return sendCsv(res, `stock-${q.status}.csv`, stockColumns, report.rows);
  res.json({ data: report });
});
