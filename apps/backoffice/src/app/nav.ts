import {
  Activity,
  ArrowLeftRight,
  Banknote,
  BookOpen,
  CalendarRange,
  Landmark,
  ListTree,
  NotebookPen,
  Scale,
  TrendingUp,
  Waves,
  Wallet,
  Flag,
  Globe,
  ClipboardCheck,
  Contact,
  Receipt,
  Store,
  Boxes,
  FileText,
  Hourglass,
  PackageCheck,
  ShoppingCart,
  Undo2,
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
  permission?: Permission | Permission[];
}

const STATEMENTS: Permission[] = ['reports.financial', 'accounting.view'];

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Only implemented routes appear here; each phase adds its module's entries. */
export const navGroups: NavGroup[] = [
  {
    label: 'Sales',
    items: [
      { label: 'Point of sale', to: '/pos', icon: Store, permission: 'pos.sell' },
      { label: 'Sales', to: '/sales', icon: Receipt, permission: ['sales.view', 'pos.sell'] },
      { label: 'Shifts', to: '/pos/shifts', icon: ClipboardCheck, permission: ['pos.shift.reconcile', 'sales.view'] },
      { label: 'Online orders', to: '/orders', icon: Globe, permission: 'orders.view' },
      { label: 'Customers', to: '/customers', icon: Contact, permission: 'customers.view' },
    ],
  },
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
    items: [
      { label: 'Purchase orders', to: '/purchasing/orders', icon: ShoppingCart, permission: 'purchasing.view' },
      { label: 'Goods received', to: '/purchasing/receipts', icon: PackageCheck, permission: 'purchasing.view' },
      { label: 'Supplier invoices', to: '/purchasing/invoices', icon: FileText, permission: 'purchasing.view' },
      { label: 'Supplier payments', to: '/purchasing/payments', icon: Banknote, permission: 'purchasing.view' },
      { label: 'Returns to suppliers', to: '/purchasing/returns', icon: Undo2, permission: 'purchasing.view' },
      { label: 'Aged payables', to: '/purchasing/payables', icon: Hourglass, permission: 'purchasing.view' },
      { label: 'Suppliers', to: '/suppliers', icon: Truck, permission: 'suppliers.view' },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { label: 'Chart of accounts', to: '/accounting/accounts', icon: ListTree, permission: 'accounting.view' },
      { label: 'Journals', to: '/accounting/journals', icon: NotebookPen, permission: 'accounting.view' },
      { label: 'General ledger', to: '/accounting/ledger', icon: BookOpen, permission: 'accounting.view' },
      { label: 'Periods', to: '/accounting/periods', icon: CalendarRange, permission: 'accounting.view' },
      { label: 'Opening balances', to: '/accounting/opening-balances', icon: Flag, permission: 'accounting.view' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { label: 'Profit and loss', to: '/reports/profit-and-loss', icon: TrendingUp, permission: STATEMENTS },
      { label: 'Balance sheet', to: '/reports/balance-sheet', icon: Landmark, permission: STATEMENTS },
      { label: 'Cash flow', to: '/reports/cash-flow', icon: Waves, permission: STATEMENTS },
      { label: 'Trial balance', to: '/reports/trial-balance', icon: Scale, permission: STATEMENTS },
      { label: 'Aged receivables', to: '/reports/receivables', icon: Wallet, permission: STATEMENTS },
    ],
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
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || (Array.isArray(i.permission) ? i.permission.some(can) : can(i.permission))) }))
    .filter((g) => g.items.length > 0);
}
