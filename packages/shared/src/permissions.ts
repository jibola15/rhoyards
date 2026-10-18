/**
 * Permission catalogue for the whole system. The API enforces these; the frontends use them
 * only to decide what to show. Adding a permission here + re-running the seed makes it assignable.
 */
export const PERMISSIONS = {
  // Administration
  'users.view': 'View staff users',
  'users.manage': 'Create, edit and disable staff users',
  'roles.manage': 'Create and edit roles and their permissions',
  'settings.view': 'View business settings',
  'settings.manage': 'Change business, tax-pricing and inventory settings',
  'taxes.manage': 'Manage tax rates',
  'locations.manage': 'Manage store and warehouse locations',
  'audit.view': 'View the audit log',
  // Catalogue & inventory
  'catalog.view': 'View products, brands and categories',
  'catalog.manage': 'Create and edit products, variants, brands and categories',
  'inventory.view': 'View stock levels and movements',
  'inventory.adjust': 'Create stock adjustments',
  'inventory.adjust.approve': 'Approve and post stock adjustments',
  'inventory.transfer': 'Create and receive stock transfers',
  'stock.negative.allow': 'Allow a sale or issue to take stock below zero (when enabled in settings)',
  // Purchasing
  'suppliers.view': 'View suppliers and statements',
  'suppliers.manage': 'Create and edit suppliers',
  'purchasing.view': 'View purchase orders, receipts and supplier invoices',
  'purchasing.manage': 'Create purchase orders, receive goods, enter supplier invoices and returns',
  'purchasing.approve': 'Approve purchase orders',
  'supplier_payments.manage': 'Record supplier payments',
  // Customers & sales
  'customers.view': 'View customers and statements',
  'customers.manage': 'Create and edit customers',
  'pos.sell': 'Ring up sales at the POS',
  'pos.discount': 'Apply discounts within the standard limit',
  'pos.discount.override': 'Authorise discounts above the standard limit',
  'pos.price.override': 'Override selling prices at the POS',
  'pos.credit_sale': 'Complete sales on customer credit',
  'pos.shift.manage': 'Open and close cashier shifts',
  'pos.shift.reconcile': 'Review and reconcile any cashier shift',
  'returns.create': 'Create sales returns and exchanges',
  'returns.approve': 'Approve returns and refunds',
  'refunds.process': 'Pay out approved refunds',
  // Online orders
  'orders.view': 'View online orders',
  'orders.manage': 'Update online order status and fulfilment',
  'payments.verify': 'Manually verify an online payment',
  // Expenses
  'expenses.view': 'View expenses',
  'expenses.create': 'Record expenses',
  'expenses.approve': 'Approve and post expenses',
  // Accounting
  'accounting.view': 'View chart of accounts, journals and ledgers',
  'accounts.manage': 'Edit the chart of accounts',
  'journals.create': 'Create draft manual journals',
  'journals.post': 'Post manual journals',
  'journals.reverse': 'Reverse posted journals',
  'periods.manage': 'Open and close accounting periods',
  'reconciliation.manage': 'Perform bank and cash reconciliations',
  // Reporting
  'dashboard.view': 'View the management dashboard',
  'reports.sales': 'View sales reports',
  'reports.inventory': 'View inventory reports',
  'reports.financial': 'View financial statements',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_CODES = [
  'OWNER',
  'MANAGER',
  'ACCOUNTANT',
  'INVENTORY_OFFICER',
  'CASHIER',
  'ONLINE_ORDER_MANAGER',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

/** The Owner role always holds every permission and cannot be edited. */
export const OWNER_ROLE: RoleCode = 'OWNER';

interface SystemRoleDefinition {
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/** Default permissions for the seeded system roles. Roles other than OWNER can be edited afterwards. */
export const SYSTEM_ROLES: Record<RoleCode, SystemRoleDefinition> = {
  OWNER: {
    name: 'Owner / Administrator',
    description: 'Full access to every function',
    permissions: ALL_PERMISSIONS,
  },
  MANAGER: {
    name: 'Manager',
    description: 'Runs the store: staff, stock, purchasing, sales oversight and reports',
    permissions: [
      'users.view', 'users.manage', 'settings.view', 'locations.manage', 'audit.view',
      'catalog.view', 'catalog.manage', 'inventory.view', 'inventory.adjust', 'inventory.adjust.approve',
      'inventory.transfer', 'suppliers.view', 'suppliers.manage', 'purchasing.view', 'purchasing.manage',
      'purchasing.approve', 'customers.view', 'customers.manage', 'pos.sell', 'pos.discount',
      'pos.discount.override', 'pos.price.override', 'pos.credit_sale', 'pos.shift.manage', 'pos.shift.reconcile',
      'returns.create', 'returns.approve', 'refunds.process', 'orders.view', 'orders.manage', 'payments.verify',
      'expenses.view', 'expenses.create', 'expenses.approve', 'dashboard.view', 'reports.sales',
      'reports.inventory', 'reports.financial',
    ],
  },
  ACCOUNTANT: {
    name: 'Accountant',
    description: 'Ledger, tax, payables, expenses, reconciliation and financial reporting',
    permissions: [
      'settings.view', 'settings.manage', 'taxes.manage', 'audit.view', 'catalog.view', 'inventory.view',
      'suppliers.view', 'purchasing.view', 'supplier_payments.manage', 'customers.view', 'orders.view',
      'payments.verify', 'pos.shift.reconcile', 'expenses.view', 'expenses.create', 'expenses.approve',
      'accounting.view', 'accounts.manage', 'journals.create', 'journals.post', 'journals.reverse',
      'periods.manage', 'reconciliation.manage', 'dashboard.view', 'reports.sales', 'reports.inventory',
      'reports.financial',
    ],
  },
  INVENTORY_OFFICER: {
    name: 'Inventory Officer',
    description: 'Catalogue, stock control, receiving and transfers',
    permissions: [
      'catalog.view', 'catalog.manage', 'inventory.view', 'inventory.adjust', 'inventory.transfer',
      'suppliers.view', 'suppliers.manage', 'purchasing.view', 'purchasing.manage', 'reports.inventory',
    ],
  },
  CASHIER: {
    name: 'Cashier',
    description: 'Point-of-sale sales, customer lookup and return requests',
    permissions: [
      'catalog.view', 'inventory.view', 'customers.view', 'customers.manage', 'pos.sell', 'pos.discount',
      'pos.shift.manage', 'returns.create',
    ],
  },
  ONLINE_ORDER_MANAGER: {
    name: 'Online Order Manager',
    description: 'Processes and fulfils online orders',
    permissions: [
      'catalog.view', 'inventory.view', 'customers.view', 'customers.manage', 'orders.view', 'orders.manage',
      'returns.create',
    ],
  },
};
