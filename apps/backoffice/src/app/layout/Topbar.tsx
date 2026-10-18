import { Menu, Moon, Sun } from 'lucide-react';
import { Button } from '@rhoyards/ui';

interface TopbarProps {
  onOpenMobileNav: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export function Topbar({ onOpenMobileNav, theme, onToggleTheme }: TopbarProps) {
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
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </div>
    </header>
  );
}
