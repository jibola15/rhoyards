import {
  Activity,
  ArrowLeftRight,
  Boxes,
  CalendarClock,
  ClipboardList,
  History,
  Package,
  Settings,
  ShieldCheck,
  Tags,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
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
    label: 'Catalogue',
    items: [
      { label: 'Products', to: '/catalog/products', icon: Package, permission: 'catalog.view' },
      { label: 'Catalogue setup', to: '/catalog/setup', icon: Tags, permission: 'catalog.view' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Stock levels', to: '/inventory/stock', icon: Boxes, permission: 'inventory.view' },
      { label: 'Adjustments', to: '/inventory/adjustments', icon: ClipboardList, permission: 'inventory.view' },
      { label: 'Transfers', to: '/inventory/transfers', icon: ArrowLeftRight, permission: 'inventory.view' },
      { label: 'Expiry', to: '/inventory/expiry', icon: CalendarClock, permission: 'inventory.view' },
      { label: 'Stock movements', to: '/inventory/movements', icon: History, permission: 'inventory.view' },
    ],
  },
  {
    label: 'Purchasing',
    items: [{ label: 'Suppliers', to: '/suppliers', icon: Truck, permission: 'suppliers.view' }],
  },
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
