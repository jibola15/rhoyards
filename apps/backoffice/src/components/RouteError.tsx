import { useRouteError } from 'react-router';
import { AppErrorScreen, isStaleCodeError, reloadOnceForUpdate } from '@rhoyards/ui';

/** Any page that throws ends up here: a part of the app replaced by a new release reloads; anything else is explained. */
export function RouteError() {
  const error = useRouteError();
  if (isStaleCodeError(error) && reloadOnceForUpdate()) return null;
  return <AppErrorScreen error={error} homeHref={import.meta.env.BASE_URL} />;
}
