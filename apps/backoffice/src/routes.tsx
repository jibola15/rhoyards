import type { RouteObject } from 'react-router';
import { AppLayout } from './app/layout/AppLayout';
import { SystemStatusPage } from './features/system/SystemStatusPage';
import { NotFoundPage } from './pages/NotFoundPage';

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <SystemStatusPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
