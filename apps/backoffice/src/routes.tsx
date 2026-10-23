import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { RouteError } from './components/RouteError';
import type { RouteObject } from 'react-router';
import type { Permission } from '@rhoyards/shared';
import { AppLayout } from './app/layout/AppLayout';
import { RequireAuth, RequirePermission } from './auth/guards';
import { Home } from './features/dashboard/Home';
import { SystemStatusPage } from './features/system/SystemStatusPage';
import { AccountSecurityPage } from './pages/AccountSecurityPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordResetPages';
import { NotFoundPage } from './pages/NotFoundPage';

/** Route-level code splitting: each feature screen is downloaded when first opened. */
function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M) {
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType })));
}

const ProductsPage = page(() => import('./features/catalog/ProductsPage'), 'ProductsPage');
const ProductEditorPage = page(() => import('./features/catalog/ProductEditorPage'), 'ProductEditorPage');
const CatalogSetupPage = page(() => import('./features/catalog/CatalogSetupPage'), 'CatalogSetupPage');
const SuppliersPage = page(() => import('./features/suppliers/SuppliersPage'), 'SuppliersPage');
const StockPage = page(() => import('./features/inventory/StockPage'), 'StockPage');
const MovementsPage = page(() => import('./features/inventory/MovementsPage'), 'MovementsPage');
const ExpiryPage = page(() => import('./features/inventory/ExpiryPage'), 'ExpiryPage');
const AdjustmentsPage = page(() => import('./features/inventory/AdjustmentsPage'), 'AdjustmentsPage');
const AdjustmentPage = page(() => import('./features/inventory/AdjustmentPage'), 'AdjustmentPage');
const TransfersPage = page(() => import('./features/inventory/TransfersPage'), 'TransfersPage');
const TransferPage = page(() => import('./features/inventory/TransferPage'), 'TransferPage');
const UsersPage = page(() => import('./features/users/UsersPage'), 'UsersPage');
const RolesPage = page(() => import('./features/roles/RolesPage'), 'RolesPage');
const SettingsPage = page(() => import('./features/settings/SettingsPage'), 'SettingsPage');
const lists = () => import('./features/purchasing/PurchasingLists');
const PurchaseOrdersPage = page(lists, 'PurchaseOrdersPage');
const GoodsReceiptsPage = page(lists, 'GoodsReceiptsPage');
const SupplierInvoicesPage = page(lists, 'SupplierInvoicesPage');
const SupplierPaymentsPage = page(lists, 'SupplierPaymentsPage');
const PurchaseReturnsPage = page(lists, 'PurchaseReturnsPage');
const PurchaseOrderPage = page(() => import('./features/purchasing/PurchaseOrderPage'), 'PurchaseOrderPage');
const GoodsReceiptPage = page(() => import('./features/purchasing/GoodsReceiptPage'), 'GoodsReceiptPage');
const SupplierInvoicePage = page(() => import('./features/purchasing/SupplierInvoicePage'), 'SupplierInvoicePage');
const SupplierPaymentPage = page(() => import('./features/purchasing/SupplierPaymentPage'), 'SupplierPaymentPage');
const PurchaseReturnPage = page(() => import('./features/purchasing/PurchaseReturnPage'), 'PurchaseReturnPage');
const SupplierDetailPage = page(() => import('./features/purchasing/SupplierDetailPage'), 'SupplierDetailPage');
const PayablesAgingPage = page(() => import('./features/purchasing/PayablesAgingPage'), 'PayablesAgingPage');
const PosPage = page(() => import('./features/pos/PosPage'), 'PosPage');
const shiftPages = () => import('./features/pos/ShiftPage');
const ShiftsPage = page(shiftPages, 'ShiftsPage');
const ShiftPage = page(shiftPages, 'ShiftPage');
const salePages = () => import('./features/pos/SalesPages');
const SalesPage = page(salePages, 'SalesPage');
const SalePage = page(salePages, 'SalePage');
const ReceiptPage = page(() => import('./features/pos/Receipt'), 'ReceiptPage');
const CustomersPage = page(() => import('./features/customers/CustomersPage'), 'CustomersPage');
const orderPages = () => import('./features/orders/OrdersPages');
const returnPages = () => import('./features/returns/ReturnsPages');
const ReturnsPage = page(returnPages, 'ReturnsPage');
const NewReturnPage = page(returnPages, 'NewReturnPage');
const ReturnPage = page(returnPages, 'ReturnPage');
const CustomerDetailPage = page(() => import('./features/customers/CustomerDetailPage'), 'CustomerDetailPage');
const expensePages = () => import('./features/expenses/ExpensesPages');
const ExpensesPage = page(expensePages, 'ExpensesPage');
const ExpensePage = page(expensePages, 'ExpensePage');
const bankingPages = () => import('./features/banking/BankingPages');
const ReconciliationsPage = page(bankingPages, 'ReconciliationsPage');
const ReconciliationPage = page(bankingPages, 'ReconciliationPage');
const operational = () => import('./features/reports/OperationalReports');
const SalesReportPage = page(operational, 'SalesReportPage');
const PaymentsReportPage = page(operational, 'PaymentsReportPage');
const ExpensesReportPage = page(operational, 'ExpensesReportPage');
const StockReportPage = page(operational, 'StockReportPage');
const InventoryReportPage = page(() => import('./features/reports/InventoryReport'), 'InventoryReportPage');
const ledgers = () => import('./features/reports/LedgerReports');
const CustomerItemsReportPage = page(ledgers, 'CustomerItemsReportPage');
const ItemLedgerPage = page(ledgers, 'ItemLedgerPage');
const CustomerLedgerPage = page(ledgers, 'CustomerLedgerPage');
const AuditLogPage = page(() => import('./features/audit/AuditLogPage'), 'AuditLogPage');
const RETURN_VIEWERS: Permission[] = ['returns.create', 'returns.approve', 'refunds.process', 'sales.view'];
const EXPENSE_USERS: Permission[] = ['expenses.view', 'expenses.create', 'expenses.approve'];
const OrdersPage = page(orderPages, 'OrdersPage');
const OrderPage = page(orderPages, 'OrderPage');
const AccountsPage = page(() => import('./features/accounting/AccountsPage'), 'AccountsPage');
const JournalsPage = page(() => import('./features/accounting/JournalsPage'), 'JournalsPage');
const JournalPage = page(() => import('./features/accounting/JournalPage'), 'JournalPage');
const LedgerPage = page(() => import('./features/accounting/LedgerPage'), 'LedgerPage');
const PeriodsPage = page(() => import('./features/accounting/PeriodsPage'), 'PeriodsPage');
const OpeningBalancesPage = page(() => import('./features/accounting/OpeningBalancesPage'), 'OpeningBalancesPage');
const reports = () => import('./features/reports/FinancialReports');
const TrialBalancePage = page(reports, 'TrialBalancePage');
const ProfitLossPage = page(reports, 'ProfitLossPage');
const BalanceSheetPage = page(reports, 'BalanceSheetPage');
const CashFlowPage = page(reports, 'CashFlowPage');
const ReceivablesAgingPage = page(reports, 'ReceivablesAgingPage');
const statements: Permission[] = ['reports.financial', 'accounting.view'];

const guarded = (path: string, permission: Permission | Permission[], element: ReactNode): RouteObject => ({
  path,
  element: <RequirePermission permission={permission}>{element}</RequirePermission>,
});

const appRoutes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />,
    children: [
      // Printable pages render without the app chrome; the API decides who may see the sale.
      {
        path: 'sales/:id/receipt',
        element: (
          <Suspense fallback={null}>
            <ReceiptPage />
          </Suspense>
        ),
      },
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Home /> },
          { path: 'system', element: <SystemStatusPage /> },
          guarded('catalog/products', 'catalog.view', <ProductsPage />),
          guarded('catalog/products/new', 'catalog.manage', <ProductEditorPage />),
          guarded('catalog/products/:id', 'catalog.view', <ProductEditorPage />),
          guarded('catalog/setup', 'catalog.view', <CatalogSetupPage />),
          guarded('suppliers', 'suppliers.view', <SuppliersPage />),
          guarded('suppliers/:id', 'suppliers.view', <SupplierDetailPage />),
          guarded('purchasing/orders', 'purchasing.view', <PurchaseOrdersPage />),
          guarded('purchasing/orders/new', 'purchasing.manage', <PurchaseOrderPage />),
          guarded('purchasing/orders/:id', 'purchasing.view', <PurchaseOrderPage />),
          guarded('purchasing/receipts', 'purchasing.view', <GoodsReceiptsPage />),
          guarded('purchasing/receipts/new', 'purchasing.manage', <GoodsReceiptPage />),
          guarded('purchasing/receipts/:id', 'purchasing.view', <GoodsReceiptPage />),
          guarded('purchasing/invoices', 'purchasing.view', <SupplierInvoicesPage />),
          guarded('purchasing/invoices/new', 'supplier_invoices.manage', <SupplierInvoicePage />),
          guarded('purchasing/invoices/:id', 'purchasing.view', <SupplierInvoicePage />),
          guarded('purchasing/payments', 'purchasing.view', <SupplierPaymentsPage />),
          guarded('purchasing/payments/new', 'supplier_payments.manage', <SupplierPaymentPage />),
          guarded('purchasing/payments/:id', 'purchasing.view', <SupplierPaymentPage />),
          guarded('purchasing/returns', 'purchasing.view', <PurchaseReturnsPage />),
          guarded('purchasing/returns/new', 'purchasing.manage', <PurchaseReturnPage />),
          guarded('purchasing/returns/:id', 'purchasing.view', <PurchaseReturnPage />),
          guarded('purchasing/payables', ['purchasing.view', 'reports.financial'], <PayablesAgingPage />),
          guarded('pos', 'pos.sell', <PosPage />),
          guarded('pos/shifts', ['pos.shift.reconcile', 'sales.view'], <ShiftsPage />),
          guarded('pos/shifts/:id', ['pos.shift.manage', 'pos.shift.reconcile', 'sales.view'], <ShiftPage />),
          guarded('sales', ['sales.view', 'pos.sell'], <SalesPage />),
          guarded('sales/:id', ['sales.view', 'pos.sell'], <SalePage />),
          guarded('customers', 'customers.view', <CustomersPage />),
          guarded('customers/:id', ['customers.view', 'customer_receipts.manage'], <CustomerDetailPage />),
          guarded('returns', RETURN_VIEWERS, <ReturnsPage />),
          guarded('returns/new', 'returns.create', <NewReturnPage />),
          guarded('returns/:id', RETURN_VIEWERS, <ReturnPage />),
          guarded('expenses', EXPENSE_USERS, <ExpensesPage />),
          guarded('expenses/new', 'expenses.create', <ExpensePage />),
          guarded('expenses/:id', EXPENSE_USERS, <ExpensePage />),
          guarded('banking/reconciliations', ['reconciliation.manage', 'accounting.view'], <ReconciliationsPage />),
          guarded('banking/reconciliations/:id', ['reconciliation.manage', 'accounting.view'], <ReconciliationPage />),
          guarded('orders', 'orders.view', <OrdersPage />),
          guarded('orders/:id', 'orders.view', <OrderPage />),
          guarded('accounting/accounts', 'accounting.view', <AccountsPage />),
          guarded('accounting/journals', 'accounting.view', <JournalsPage />),
          guarded('accounting/journals/new', 'journals.create', <JournalPage />),
          guarded('accounting/journals/:id', 'accounting.view', <JournalPage />),
          guarded('accounting/ledger', 'accounting.view', <LedgerPage />),
          guarded('accounting/periods', 'accounting.view', <PeriodsPage />),
          guarded('accounting/opening-balances', 'accounting.view', <OpeningBalancesPage />),
          guarded('reports/trial-balance', statements, <TrialBalancePage />),
          guarded('reports/profit-and-loss', statements, <ProfitLossPage />),
          guarded('reports/balance-sheet', statements, <BalanceSheetPage />),
          guarded('reports/cash-flow', statements, <CashFlowPage />),
          guarded('reports/receivables', statements, <ReceivablesAgingPage />),
          guarded('reports/sales', 'reports.sales', <SalesReportPage />),
          guarded('reports/payments', ['reports.sales', 'reports.financial'], <PaymentsReportPage />),
          guarded('reports/expenses', ['reports.financial', 'expenses.view'], <ExpensesReportPage />),
          guarded('reports/stock', ['reports.inventory', 'inventory.view'], <StockReportPage />),
          guarded('reports/inventory', ['reports.inventory', 'inventory.view'], <InventoryReportPage />),
          guarded('reports/customer-items', 'reports.sales', <CustomerItemsReportPage />),
          guarded('reports/item-ledger', ['reports.inventory', 'inventory.view'], <ItemLedgerPage />),
          guarded('reports/customer-ledger', ['customers.view', 'reports.sales'], <CustomerLedgerPage />),
          guarded('audit', 'audit.view', <AuditLogPage />),
          guarded('inventory/stock', 'inventory.view', <StockPage />),
          guarded('inventory/movements', 'inventory.view', <MovementsPage />),
          guarded('inventory/expiry', 'inventory.view', <ExpiryPage />),
          guarded('inventory/adjustments', 'inventory.view', <AdjustmentsPage />),
          guarded('inventory/adjustments/new', 'inventory.adjust', <AdjustmentPage />),
          guarded('inventory/adjustments/:id', 'inventory.view', <AdjustmentPage />),
          guarded('inventory/transfers', 'inventory.view', <TransfersPage />),
          guarded('inventory/transfers/new', 'inventory.transfer', <TransferPage />),
          guarded('inventory/transfers/:id', 'inventory.view', <TransferPage />),
          guarded('users', 'users.view', <UsersPage />),
          guarded('roles', 'users.view', <RolesPage />),
          guarded('settings', 'settings.view', <SettingsPage />),
          { path: 'account/password', element: <ChangePasswordPage /> },
          { path: 'account/security', element: <AccountSecurityPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

/** Every page sits under one error page (see components/RouteError.tsx). */
export const routes: RouteObject[] = [{ errorElement: <RouteError />, children: appRoutes }];
