import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { ChevronRight, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { Button, cn } from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { visibleNav } from '../nav';

/** Whether a menu item is the current page or one of its sub-pages (e.g. /sales/123 belongs to Sales). */
function isCurrent(to: string, pathname: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const { can } = useAuth();
  const navGroups = visibleNav(can);
  const { pathname } = useLocation();
  /** Groups opened with a click (touch screens and keyboards have no hover). */
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const togglePinned = (label: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      )}
      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        data-collapsed={collapsed}
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[transform,width] duration-200 md:static md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed && 'md:w-16',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-sidebar-border px-3">
          <span className={cn('truncate px-1 text-base font-semibold', collapsed && 'md:sr-only')}>
            Rhoyards
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={onCloseMobile}
            aria-label="Close navigation"
          >
            <X />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </div>

        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto p-2">
          {navGroups.map((group) => {
            // A group shows its items while hovered or focused; it stays open when it holds the current page, when
            // pinned with a click, when it has a single item, and in the icon-only sidebar (no headings to hover).
            const holdsCurrent = group.items.some((item) => isCurrent(item.to, pathname));
            const open = holdsCurrent || pinned.has(group.label) || group.items.length === 1;
            const listId = `nav-group-${group.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            return (
              <div key={group.label} className="group/nav mb-2">
                <button
                  type="button"
                  onClick={() => togglePinned(group.label)}
                  aria-expanded={open}
                  aria-controls={listId}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-sidebar-foreground',
                    collapsed && 'md:sr-only',
                  )}
                >
                  {group.label}
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 transition-transform duration-150 group-hover/nav:rotate-90 group-focus-within/nav:rotate-90',
                      open && 'rotate-90',
                    )}
                  />
                </button>
                <ul
                  id={listId}
                  className={cn(
                    'space-y-0.5 pb-2',
                    !open && 'hidden group-hover/nav:block group-focus-within/nav:block',
                    collapsed && 'md:block',
                  )}
                >
                  {group.items.map(({ label, to, icon: Icon }) => (
                    <li key={to}>
                      <NavLink
                        to={to}
                        end
                        onClick={onCloseMobile}
                        title={collapsed ? label : undefined}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium hover:bg-sidebar-accent',
                            isActive && 'bg-sidebar-accent text-primary',
                            collapsed && 'md:justify-center',
                          )
                        }
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        <span className={cn(collapsed && 'md:sr-only')}>{label}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
