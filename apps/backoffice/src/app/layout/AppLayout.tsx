import { Suspense, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { Skeleton } from '@rhoyards/ui';
import { readPreference, writePreference } from '../../lib/storage';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const saved = readPreference('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => readPreference('sidebar-collapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      writePreference('sidebar-collapsed', String(!c));
      return !c;
    });

  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      writePreference('theme', next);
      return next;
    });

  return (
    <div className="flex min-h-svh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
      >
        Skip to content
      </a>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMobileNav={() => setMobileOpen(true)} theme={theme} onToggleTheme={toggleTheme} />
        <main id="main" className="flex-1 p-4 md:p-6">
          <Suspense
            fallback={
              <div aria-busy="true" aria-label="Loading page" className="space-y-4">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
