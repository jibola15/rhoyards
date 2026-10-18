import type { RouteObject } from 'react-router';
import { AppLayout } from './app/layout/AppLayout';
import { RequireAuth, RequirePermission } from './auth/guards';
import { RolesPage } from './features/roles/RolesPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { SystemStatusPage } from './features/system/SystemStatusPage';
import { UsersPage } from './features/users/UsersPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <SystemStatusPage /> },
          {
            path: 'users',
            element: (
              <RequirePermission permission="users.view">
                <UsersPage />
              </RequirePermission>
            ),
          },
          {
            path: 'roles',
            element: (
              <RequirePermission permission="users.view">
                <RolesPage />
              </RequirePermission>
            ),
          },
          {
            path: 'settings',
            element: (
              <RequirePermission permission="settings.view">
                <SettingsPage />
              </RequirePermission>
            ),
          },
          { path: 'account/password', element: <ChangePasswordPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
