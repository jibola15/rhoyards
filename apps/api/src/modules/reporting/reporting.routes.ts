import { Router, type Request } from 'express';
import {
  customerItemsQuerySchema,
  customerLedgerQuerySchema,
  dashboardQuerySchema,
  inventoryReportQuerySchema,
  itemLedgerQuerySchema,
  periodReportQuerySchema,
  SALES_GROUP_LABELS,
  salesReportQuerySchema,
  stockReportQuerySchema,
  type CustomerItemsRow,
  type CustomerLedgerLine,
  type ExpensesReport,
  type InventoryReport,
  type ItemLedgerLine,
  type PaymentsReport,
  type SalesReportRow,
  type StockReport,
} from '@rhoyards/shared';
import { sendCsv, type CsvColumn } from '../../lib/csv';
import { getPrisma } from '../../lib/prisma';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { assertLocationAccess, locationScope } from '../auth/location-scope';
import { getDashboard } from './dashboard.service';
import { customerItemsReport, customerLedger, itemLedger } from './ledgers.service';
import { expensesReport, inventoryReport, paymentsReport, salesReport, stockReport } from './operational.service';

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
  ['/dashboard', 'Management dashboard: sales, profit, sales chart and best sellers for ?period= (default this month); balances and attention items as of now; ?locationId= for one store (dashboard.view)', { query: dashboardQuerySchema }],
  ['/reports/sales', 'Sales by day, product, category, brand, cashier, channel, location or customer; ?format=csv (reports.sales)', { query: salesReportQuerySchema }],
  ['/reports/payments', 'Money taken and refunded by payment method; ?format=csv (reports.sales or reports.financial)', { query: periodReportQuerySchema }],
  ['/reports/expenses', 'Posted expenses by category, whole business; ?format=csv (reports.financial or expenses.view)', { query: expensesQuerySchema }],
  ['/reports/stock', 'Stock on hand, value, rate of sale and status, with each store’s quantity; ?format=csv (reports.inventory or inventory.view)', { query: stockReportQuerySchema }],
  ['/reports/inventory', 'Stock on hand and value business-wide and at each store, products and stores A–Z; ?view=by-location for one CSV row per store and product; ?format=csv (reports.inventory or inventory.view)', { query: inventoryReportQuerySchema }],
  ['/reports/customer-items', 'Items bought per customer, less returns; ?format=csv (reports.sales)', { query: customerItemsQuerySchema }],
  ['/reports/item-ledger', 'One item’s stock movements with opening, running and closing quantity, at a store or business-wide; ?format=csv (reports.inventory or inventory.view)', { query: itemLedgerQuerySchema }],
  ['/reports/customer-ledger', 'One customer’s sales, payments and returns with opening, running and closing balance; ?format=csv (customers.view or reports.sales)', { query: customerLedgerQuerySchema }],
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
type StockRow = StockReport['rows'][number];
const stockColumns = (stores: StockReport['stores']): CsvColumn<StockRow>[] => [
  { header: 'SKU', value: (r) => r.sku },
  { header: 'Product', value: (r) => r.product },
  { header: 'Variant', value: (r) => r.variant },
  { header: 'On hand', value: (r) => r.onHand },
  ...stores.map((st, i): CsvColumn<StockRow> => ({ header: `At ${st.name}`, value: (r) => r.byStore[i] })),
  { header: 'Reserved', value: (r) => r.reserved },
  { header: 'Average cost', value: (r) => r.avgCost },
  { header: 'Value', value: (r) => r.value },
  { header: 'Reorder level', value: (r) => r.reorderLevel },
  { header: 'Sold in period', value: (r) => r.soldInPeriod },
  { header: 'Days of cover', value: (r) => r.daysOfCover },
  { header: 'Status', value: (r) => r.status },
];
type InventoryRow = InventoryReport['rows'][number];
const inventoryColumns = (stores: InventoryReport['stores']): CsvColumn<InventoryRow>[] => [
  { header: 'SKU', value: (r) => r.sku },
  { header: 'Product', value: (r) => r.product },
  { header: 'Variant', value: (r) => r.variant },
  { header: 'Total on hand', value: (r) => r.onHand },
  { header: 'Total value', value: (r) => r.value },
  ...stores.flatMap((st, i): CsvColumn<InventoryRow>[] => [
    { header: `${st.name} qty`, value: (r) => r.byStore[i]!.qty },
    { header: `${st.name} value`, value: (r) => r.byStore[i]!.value },
  ]),
  { header: 'Average cost', value: (r) => r.avgCost },
];
type InventoryStoreLine = { store: string; row: InventoryRow; qty: string; value: string };
const inventoryByStoreColumns: CsvColumn<InventoryStoreLine>[] = [
  { header: 'Location', value: (l) => l.store },
  { header: 'SKU', value: (l) => l.row.sku },
  { header: 'Product', value: (l) => l.row.product },
  { header: 'Variant', value: (l) => l.row.variant },
  { header: 'On hand', value: (l) => l.qty },
  { header: 'Average cost', value: (l) => l.row.avgCost },
  { header: 'Value', value: (l) => l.value },
];
const customerItemColumns: CsvColumn<CustomerItemsRow>[] = [
  { header: 'Customer code', value: (r) => r.customerCode },
  { header: 'Customer', value: (r) => r.customer },
  { header: 'SKU', value: (r) => r.sku },
  { header: 'Product', value: (r) => r.product },
  { header: 'Qty bought', value: (r) => r.qtySold },
  { header: 'Qty returned', value: (r) => r.qtyReturned },
  { header: 'Net sales', value: (r) => r.netSales },
  { header: 'Total incl. VAT', value: (r) => r.total },
  { header: 'Last bought', value: (r) => r.lastBought },
];
const itemLedgerColumns: CsvColumn<ItemLedgerLine>[] = [
  { header: 'When', value: (r) => r.at },
  { header: 'Type', value: (r) => r.type },
  { header: 'Reference', value: (r) => r.reference ?? r.sourceType },
  { header: 'Store', value: (r) => r.location },
  { header: 'Lot', value: (r) => r.lotNumber },
  { header: 'In', value: (r) => r.qtyIn },
  { header: 'Out', value: (r) => r.qtyOut },
  { header: 'Balance', value: (r) => r.balance },
  { header: 'Unit cost', value: (r) => r.unitCost },
  { header: 'Value', value: (r) => r.value },
  { header: 'By', value: (r) => r.by },
];
const customerLedgerColumns: CsvColumn<CustomerLedgerLine>[] = [
  { header: 'Date', value: (r) => r.date },
  { header: 'Type', value: (r) => r.type },
  { header: 'Number', value: (r) => r.number },
  { header: 'Store', value: (r) => r.location },
  { header: 'Description', value: (r) => r.description },
  { header: 'Debit', value: (r) => r.debit },
  { header: 'Credit', value: (r) => r.credit },
  { header: 'Balance', value: (r) => r.balance },
];

export const reportingRouter = Router();

reportingRouter.get('/dashboard', ...requirePermission('dashboard.view'), async (req, res) => {
  const q = parse(dashboardQuerySchema, req.query);
  res.json({ data: await getDashboard(await reportStores(req, q.locationId), q.period) });
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
  if (q.format === 'csv') return sendCsv(res, `stock-${q.status}.csv`, stockColumns(report.stores), report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/inventory', ...requireAnyPermission('reports.inventory', 'inventory.view'), async (req, res) => {
  const q = parse(inventoryReportQuerySchema, req.query);
  const report = await inventoryReport({ ...q, stores: (await reportStores(req, q.locationId, true))?.ids ?? null });
  if (q.format === 'csv') {
    if (q.view === 'summary') return sendCsv(res, 'inventory.csv', inventoryColumns(report.stores), report.rows);
    // Stores A–Z, each with its products A–Z; a product with nothing at a store is left out there unless asked for.
    const lines = report.stores.flatMap((st, i) =>
      report.rows.filter((r) => q.includeZero || r.byStore[i]!.qty !== '0.000').map((r) => ({ store: st.name, row: r, ...r.byStore[i]! })),
    );
    return sendCsv(res, 'inventory-by-location.csv', inventoryByStoreColumns, lines);
  }
  res.json({ data: report });
});
reportingRouter.get('/reports/customer-items', ...requirePermission('reports.sales'), async (req, res) => {
  const q = parse(customerItemsQuerySchema, req.query);
  const report = await customerItemsReport({ ...q, stores: (await reportStores(req, q.locationId))?.ids ?? null });
  if (q.format === 'csv') return sendCsv(res, `items-per-customer-${report.from}-to-${report.to}.csv`, customerItemColumns, report.rows);
  res.json({ data: report });
});
reportingRouter.get('/reports/item-ledger', ...requireAnyPermission('reports.inventory', 'inventory.view'), async (req, res) => {
  const q = parse(itemLedgerQuerySchema, req.query);
  const report = await itemLedger(q);
  if (q.format === 'csv') {
    const opening = { at: report.from, type: 'OPENING BALANCE', balance: report.opening.qty, value: report.opening.value } as ItemLedgerLine;
    const closing = { at: report.to, type: 'CLOSING BALANCE', balance: report.closing.qty, value: report.closing.value } as ItemLedgerLine;
    return sendCsv(res, `item-ledger-${report.item.sku}-${report.from}-to-${report.to}.csv`, itemLedgerColumns, [opening, ...report.lines, closing]);
  }
  res.json({ data: report });
});
reportingRouter.get('/reports/customer-ledger', ...requireAnyPermission('customers.view', 'reports.sales'), async (req, res) => {
  const q = parse(customerLedgerQuerySchema, req.query);
  const report = await customerLedger(q);
  if (q.format === 'csv') {
    const opening = { date: report.from, description: 'Opening balance', balance: report.openingBalance } as CustomerLedgerLine;
    const closing = { date: report.to, description: 'Closing balance', balance: report.closingBalance } as CustomerLedgerLine;
    return sendCsv(res, `customer-ledger-${report.customer.code}-${report.from}-to-${report.to}.csv`, customerLedgerColumns, [opening, ...report.lines, closing]);
  }
  res.json({ data: report });
});
