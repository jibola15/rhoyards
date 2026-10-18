import { Activity, Settings, ShieldCheck, Users, type LucideIcon } from 'lucide-react';
import type { Permission } from '@rhoyards/shared';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Hidden from users without this permission (the API enforces it regardless). */
  permission?: Permission;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Only implemented routes appear here; each phase adds its module's entries. */
export const navGroups: NavGroup[] = [
  {
    label: 'Administration',
    items: [
      { label: 'Staff users', to: '/users', icon: Users, permission: 'users.view' },
      { label: 'Roles & permissions', to: '/roles', icon: ShieldCheck, permission: 'users.view' },
      { label: 'Settings', to: '/settings', icon: Settings, permission: 'settings.view' },
    ],
  },
  {
    label: 'System',
    items: [{ label: 'System status', to: '/', icon: Activity }],
  },
];

export function visibleNav(can: (p: Permission) => boolean): NavGroup[] {
  return navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || can(i.permission)) }))
    .filter((g) => g.items.length > 0);
}
