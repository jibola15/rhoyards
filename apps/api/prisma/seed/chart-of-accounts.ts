import type { AccountType } from '@prisma/client';

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  /** Reporting classification: CASH, CURRENT_ASSET, CURRENT_LIABILITY, EQUITY, REVENUE, CONTRA_REVENUE, OTHER_INCOME, COGS, OPERATING_EXPENSE */
  subtype: string;
  systemKey?: string;
}

/**
 * Initial chart of accounts (editable after seeding). Accounts with a systemKey are used by the
 * automatic posting rules in docs/ACCOUNTING_RULES.md and must not be deleted.
 */
export const CHART_OF_ACCOUNTS: SeedAccount[] = [
  { code: '1000', name: 'Cash on hand', type: 'ASSET', subtype: 'CASH', systemKey: 'CASH_ON_HAND' },
  { code: '1010', name: 'Bank - main account', type: 'ASSET', subtype: 'CASH', systemKey: 'BANK_MAIN' },
  { code: '1020', name: 'Card / POS terminal clearing', type: 'ASSET', subtype: 'CASH', systemKey: 'CARD_CLEARING' },
  { code: '1030', name: 'Payment gateway clearing', type: 'ASSET', subtype: 'CASH', systemKey: 'GATEWAY_CLEARING' },
  { code: '1100', name: 'Accounts receivable', type: 'ASSET', subtype: 'CURRENT_ASSET', systemKey: 'AR' },
  { code: '1200', name: 'Inventory', type: 'ASSET', subtype: 'CURRENT_ASSET', systemKey: 'INVENTORY' },
  { code: '1300', name: 'Prepayments', type: 'ASSET', subtype: 'CURRENT_ASSET' },
  { code: '2000', name: 'Accounts payable', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'AP' },
  { code: '2010', name: 'Goods received not invoiced', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'GRNI' },
  { code: '2100', name: 'VAT output', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'VAT_OUTPUT' },
  { code: '2110', name: 'VAT input (recoverable)', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'VAT_INPUT' },
  { code: '2200', name: 'Customer deposits', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'CUSTOMER_DEPOSITS' },
  { code: '2300', name: 'Accrued expenses', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY' },
  { code: '3000', name: "Owner's capital", type: 'EQUITY', subtype: 'EQUITY', systemKey: 'OWNER_CAPITAL' },
  { code: '3100', name: 'Retained earnings', type: 'EQUITY', subtype: 'EQUITY', systemKey: 'RETAINED_EARNINGS' },
  { code: '3200', name: "Owner's drawings", type: 'EQUITY', subtype: 'EQUITY', systemKey: 'OWNER_DRAWINGS' },
  { code: '3900', name: 'Opening balance equity', type: 'EQUITY', subtype: 'EQUITY', systemKey: 'OPENING_BALANCE_EQUITY' },
  { code: '4000', name: 'Sales revenue', type: 'INCOME', subtype: 'REVENUE', systemKey: 'SALES_REVENUE' },
  { code: '4010', name: 'Sales returns and allowances', type: 'INCOME', subtype: 'CONTRA_REVENUE', systemKey: 'SALES_RETURNS' },
  { code: '4020', name: 'Sales discounts', type: 'INCOME', subtype: 'CONTRA_REVENUE', systemKey: 'SALES_DISCOUNTS' },
  { code: '4100', name: 'Shipping income', type: 'INCOME', subtype: 'REVENUE', systemKey: 'SHIPPING_INCOME' },
  { code: '4200', name: 'Other income', type: 'INCOME', subtype: 'OTHER_INCOME', systemKey: 'OTHER_INCOME' },
  { code: '4900', name: 'Cash over / short', type: 'INCOME', subtype: 'OTHER_INCOME', systemKey: 'CASH_OVER_SHORT' },
  { code: '5000', name: 'Cost of goods sold', type: 'EXPENSE', subtype: 'COGS', systemKey: 'COGS' },
  { code: '5010', name: 'Inventory adjustments and shrinkage', type: 'EXPENSE', subtype: 'COGS', systemKey: 'INVENTORY_ADJUSTMENT' },
  { code: '5020', name: 'Expired and damaged stock write-off', type: 'EXPENSE', subtype: 'COGS', systemKey: 'STOCK_WRITE_OFF' },
  { code: '5030', name: 'Purchase price variance', type: 'EXPENSE', subtype: 'COGS', systemKey: 'PURCHASE_PRICE_VARIANCE' },
  { code: '6000', name: 'Rent', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6010', name: 'Salaries and wages', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6020', name: 'Electricity, fuel and utilities', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6030', name: 'Marketing and advertising', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6040', name: 'Transport and delivery', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6050', name: 'Bank charges', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', systemKey: 'BANK_CHARGES' },
  { code: '6060', name: 'Repairs and maintenance', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6070', name: 'Packaging supplies', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6080', name: 'Office and administration', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6090', name: 'Professional fees', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { code: '6100', name: 'Payment processing fees', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', systemKey: 'PAYMENT_FEES' },
  { code: '6900', name: 'Miscellaneous expenses', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
];
