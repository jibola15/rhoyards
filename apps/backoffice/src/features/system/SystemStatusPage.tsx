import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { DataEnvelope, Health } from '@rhoyards/shared';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@rhoyards/ui';
import { api } from '../../lib/api';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

export function SystemStatusPage() {
  const health = useQuery({
    queryKey: ['system', 'health'],
    queryFn: ({ signal }) => api.get<DataEnvelope<Health>>('/health', { signal }),
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
        <p className="text-sm text-muted-foreground">Live connectivity between this back office and the API.</p>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>API server</CardTitle>
            <CardDescription>Checked every 30 seconds.</CardDescription>
          </div>
          {health.isPending ? (
            <Skeleton className="h-5 w-20" />
          ) : health.isError ? (
            <Badge variant="destructive">Unreachable</Badge>
          ) : (
            <Badge variant="success">Online</Badge>
          )}
        </CardHeader>
        <CardContent>
          {health.isPending && (
            <div className="space-y-2" aria-busy="true" aria-label="Loading status">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          )}

          {health.isError && (
            <div role="alert" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                The API could not be reached: {health.error.message}. Check that the API server is running.
              </p>
              <Button variant="outline" size="sm" onClick={() => void health.refetch()} disabled={health.isFetching}>
                <RefreshCw className={health.isFetching ? 'animate-spin' : undefined} />
                Retry
              </Button>
            </div>
          )}

          {health.isSuccess && (
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Version</dt>
                <dd className="font-medium">{health.data.data.version}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Uptime</dt>
                <dd className="font-medium">{formatUptime(health.data.data.uptimeSeconds)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Server time</dt>
                <dd className="font-medium">{new Date(health.data.data.time).toLocaleString()}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
