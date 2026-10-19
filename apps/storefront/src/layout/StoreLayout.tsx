import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { Search, ShoppingBag, User } from 'lucide-react';
import { Button, Input } from '@rhoyards/ui';
import { useCustomer } from '../account/CustomerProvider';
import { useStoreInfo } from '../lib/store-info';
import { STORE_NAME } from '../config';
import { useCart } from '../lib/cart';

export function StoreLayout() {
  const info = useStoreInfo();
  const { customer, signOut } = useCustomer();
  const cart = useCart();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const name = info.data?.name ?? STORE_NAME;
  const count = cart.reduce((n, i) => n + i.qty, 0);
  const search = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/shop${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
  };

  return (
    <div className="flex min-h-svh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-background focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            {name}
          </Link>
          <nav aria-label="Main" className="hidden text-sm sm:block">
            <NavLink to="/shop" className={({ isActive }) => (isActive ? 'font-medium' : 'text-muted-foreground hover:text-foreground')}>
              Shop
            </NavLink>
          </nav>
          <form role="search" onSubmit={search} className="relative ml-auto hidden max-w-xs flex-1 md:block">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <Input type="search" aria-label="Search products" placeholder="Search products" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <div className="ml-auto flex items-center gap-1 md:ml-0">
            {customer ? (
              <>
                <Link to="/account/orders" className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                  <User className="size-4" aria-hidden="true" /> <span className="hidden sm:inline">My orders</span>
                </Link>
                <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                  Sign out
                </Button>
              </>
            ) : (
              <Link to="/account/login" className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                <User className="size-4" aria-hidden="true" /> Sign in
              </Link>
            )}
            <Link to="/cart" className="relative inline-flex items-center rounded-md p-2 hover:bg-muted" aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}>
              <ShoppingBag className="size-5" aria-hidden="true" />
              {count > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">{count}</span>}
            </Link>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:justify-between">
          <span>
            © {new Date().getFullYear()} {name}
          </span>
          {info.data && <span>{[info.data.address, info.data.phone, info.data.email].filter(Boolean).join(' · ')}</span>}
        </div>
      </footer>
    </div>
  );
}
