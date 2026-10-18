import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import type { Permission } from '@rhoyards/shared';
import { Alert, Button, Skeleton } from '@rhoyards/ui';
import { ForbiddenPage } from '../pages/ForbiddenPage';
import { useAuth } from './AuthProvider';

function FullPageLoader() {
  return (
    <div className="flex min-h-svh items-center justify-center" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}

/** Gate for the signed-in area. Server-side checks remain authoritative; this only routes the user. */
export function RequireAuth() {
  const { session, isLoading, error, refresh } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageLoader />;
  if (error) {
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert variant="destructive" className="space-y-3">
          <p>Could not reach the server: {error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Try again
          </Button>
        </Alert>
      </div>
    );
  }
  if (!session) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }
  if (session.user.mustChangePassword && location.pathname !== '/account/password') {
    return <Navigate to="/account/password" replace />;
  }
  return <Outlet />;
}

export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <ForbiddenPage />;
}
