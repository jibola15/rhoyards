import { lazy, Suspense } from 'react';
import { Skeleton } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { SystemStatusPage } from '../system/SystemStatusPage';

// The charting library is only downloaded by people who can see the dashboard.
const DashboardPage = lazy(() => import('./DashboardPage').then((m) => ({ default: m.DashboardPage })));

/** The home page: the dashboard for managers, the system status for everyone else. */
export function Home() {
  const { can } = useAuth();
  if (!can('dashboard.view')) return <SystemStatusPage />;
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <DashboardPage />
    </Suspense>
  );
}
