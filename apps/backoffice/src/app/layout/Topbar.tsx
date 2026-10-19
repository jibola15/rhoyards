import { Link, useNavigate } from 'react-router';
import { LogOut, Menu, Moon, ShieldCheck, Sun } from 'lucide-react';
import { Button, buttonVariants, toast } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';

interface TopbarProps {
  onOpenMobileNav: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export function Topbar({ onOpenMobileNav, theme, onToggleTheme }: TopbarProps) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const user = session?.user;

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
        aria-controls="app-sidebar"
      >
        <Menu />
      </Button>
      <span className="font-semibold md:hidden">Rhoyards</span>
      <div className="ml-auto flex items-center gap-1">
        {user && (
          <div className="mr-2 hidden text-right leading-tight sm:block">
            <div className="text-sm font-medium">{user.fullName}</div>
            <div className="text-xs text-muted-foreground">{user.roles.map((r) => r.name).join(', ')}</div>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        {user && (
          <>
            <Link to="/account/security" className={buttonVariants({ variant: 'ghost', size: 'icon' })} aria-label="Account security" title="Account security: password and two-step sign-in">
              <ShieldCheck />
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                try {
                  await logout();
                } catch {
                  toast.error('Sign-out could not reach the server; your local session was cleared.');
                }
                navigate('/login', { replace: true });
              }}
            >
              <LogOut />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
