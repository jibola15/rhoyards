import { useSyncExternalStore } from 'react';
import { Button } from './button';

/**
 * Keeping open browser tabs in step with a new release. The API names its release in `X-App-Version`; a tab built
 * from another release shows a bar offering to reload. Code split into chunks that a release has removed would
 * fail to load: that reloads the page (once) instead of breaking.
 */

let updateAvailable = false;
const listeners = new Set<() => void>();

/** Call with each API response's X-App-Version. `clientBuild` is empty in development (no check). */
export function noteServerBuild(serverBuild: string | null, clientBuild: string): void {
  if (updateAvailable || !serverBuild || !clientBuild || serverBuild === clientBuild) return;
  updateAvailable = true;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => updateAvailable, () => false);
}

/** A bar at the bottom of the screen while a newer release is running on the server. */
export function NewVersionBanner({ appName = 'Rhoyards' }: { appName?: string }) {
  const available = useUpdateAvailable();
  if (!available) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-3 border-t bg-primary px-4 py-3 text-sm text-primary-foreground shadow-lg print:hidden">
      <span>A new version of {appName} is available. Reload to use it (finish anything you are typing first).</span>
      <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

const RELOAD_FLAG = 'rhoyards.reloaded-for-update';

/** Errors a browser gives when a lazily loaded part of the app is gone (replaced by a new release). */
export function isStaleCodeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch dynamically|ChunkLoadError|Unable to preload CSS/i.test(message);
}

/** Reloads once per tab session; a second failure in a row is shown instead, so it can never loop. */
export function reloadOnceForUpdate(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Call once at start-up. */
export function installUpdateHandling(): void {
  // Vite reports a chunk that failed to preload; reload rather than let the page break.
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForUpdate()) event.preventDefault();
  });
  // A page that loaded fine clears the guard, so the next release can reload again.
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      // ignore
    }
  }, 10_000);
}

/** Shown when a page fails: plain words and a way out, instead of a stack trace. */
export function AppErrorScreen({ error, homeHref = '/' }: { error: unknown; homeHref?: string }) {
  const stale = isStaleCodeError(error);
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-lg font-semibold">{stale ? 'This page has been updated' : 'Something went wrong on this page'}</h1>
        <p className="text-sm text-muted-foreground">
          {stale
            ? 'A new version of the app was released while this page was open. Reload to continue.'
            : 'Reloading usually fixes this, especially just after an update. If it keeps happening, tell your administrator what you were doing.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button variant="outline" onClick={() => window.location.assign(homeHref)}>
            Go to the start page
          </Button>
        </div>
        {!stale && error instanceof Error && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-2 break-words font-mono">{error.message}</p>
          </details>
        )}
      </div>
    </main>
  );
}
