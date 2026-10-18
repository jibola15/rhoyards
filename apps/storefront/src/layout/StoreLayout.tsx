import { Link, Outlet } from 'react-router';
import { STORE_NAME } from '../config';

export function StoreLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            {STORE_NAME}
          </Link>
        </div>
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">
          © {new Date().getFullYear()} {STORE_NAME}
        </div>
      </footer>
    </div>
  );
}
