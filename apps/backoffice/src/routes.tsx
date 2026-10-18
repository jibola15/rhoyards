import { lazy, type ComponentType, type ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@rhoyards/shared';
import { AppLayout } from './app/layout/AppLayout';
import { RequireAuth, RequirePermission } from './auth/guards';
import { SystemStatusPage } from './features/system/SystemStatusPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
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

const guarded = (path: string, permission: Permission, element: ReactNode): RouteObject => ({
  path,
  element: <RequirePermission permission={permission}>{element}</RequirePermission>,
});

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <SystemStatusPage /> },
          guarded('catalog/products', 'catalog.view', <ProductsPage />),
          guarded('catalog/products/new', 'catalog.manage', <ProductEditorPage />),
          guarded('catalog/products/:id', 'catalog.view', <ProductEditorPage />),
          guarded('catalog/setup', 'catalog.view', <CatalogSetupPage />),
          guarded('suppliers', 'suppliers.view', <SuppliersPage />),
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
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
