import { z } from 'zod';
import { listQuerySchema } from './api';
import { dateInput, moneyInput, optionalId, optionalText } from './inputs';

// ── Chart of accounts ─────────────────────────────────────────────────────

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountTypeCode = (typeof ACCOUNT_TYPES)[number];

/** Reporting classification. It decides where an account appears in the statements, so it must match the type. */
export const ACCOUNT_SUBTYPES = {
  ASSET: { CASH: 'Cash and bank', CURRENT_ASSET: 'Current asset', NON_CURRENT_ASSET: 'Non-current asset' },
  LIABILITY: { CURRENT_LIABILITY: 'Current liability', NON_CURRENT_LIABILITY: 'Non-current liability' },
  EQUITY: { EQUITY: 'Equity' },
  INCOME: { REVENUE: 'Revenue', CONTRA_REVENUE: 'Returns and discounts', OTHER_INCOME: 'Other income' },
  EXPENSE: { COGS: 'Cost of sales', OPERATING_EXPENSE: 'Operating expense', OTHER_EXPENSE: 'Other expense' },
} as const satisfies Record<AccountTypeCode, Record<string, string>>;

export const subtypeMatchesType = (type: AccountTypeCode, subtype: string) => subtype in ACCOUNT_SUBTYPES[type];

/** Debit-normal types show a balance as debit − credit; the others as credit − debit. */
export const isDebitNormal = (type: AccountTypeCode) => type === 'ASSET' || type === 'EXPENSE';

/**
 * Control accounts are fed only by their sub-ledgers (customer sales, supplier invoices and payments,
 * stock movements, goods receipts). Manual journals cannot touch them, so each stays equal to its sub-ledger.
 */
export const CONTROL_ACCOUNT_KEYS = ['AR', 'AP', 'INVENTORY', 'GRNI'] as const;

const accountCode = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/, 'Use up to 20 letters, digits, dots or dashes')
  .transform((v) => v.toUpperCase());

const accountFields = {
  code: accountCode,
  name: z.string().trim().min(1, 'Enter a name').max(120),
  type: z.enum(ACCOUNT_TYPES, 'Choose a type'),
  subtype: z.string().min(1, 'Choose a classification'),
  description: optionalText(500),
  parentId: optionalId,
  isPostable: z.boolean().default(true),
};

export const accountInputSchema = z.object(accountFields).refine((a) => subtypeMatchesType(a.type, a.subtype), {
  message: 'This classification does not belong to the chosen type',
  path: ['subtype'],
});
export type AccountInput = z.infer<typeof accountInputSchema>;

export const accountUpdateSchema = z
  .object({
    code: accountFields.code.optional(),
    name: accountFields.name.optional(),
    type: accountFields.type.optional(),
    subtype: accountFields.subtype.optional(),
    description: accountFields.description,
    parentId: accountFields.parentId,
    isPostable: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountTypeCode;
  subtype: string | null;
  description: string | null;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
  systemKey: string | null;
  /** Fed only by a sub-ledger; manual journals cannot post to it. */
  isControl: boolean;
  /** Posted balance in the account's normal direction (negative = the opposite side). */
  balance: string;
  hasEntries: boolean;
}

export interface AccountRef {
  id: string;
  code: string;
  name: string;
  type: AccountTypeCode;
}

// ── Journals ──────────────────────────────────────────────────────────────

/** A blank amount means zero, so a line form can leave the unused side empty. */
const sideAmount = z.union([moneyInput, z.literal('')]).transform((v) => (v === '' ? '0' : v));
const isZero = (v: string) => /^0*(\.0*)?$/.test(v);

export const journalLineInputSchema = z
  .object({
    accountId: z.uuid('Choose an account'),
    debit: sideAmount,
    credit: sideAmount,
    memo: optionalText(200),
  })
  .refine((l) => isZero(l.debit) !== isZero(l.credit), { message: 'Enter either a debit or a credit', path: ['debit'] });

export const journalInputSchema = z.object({
  entryDate: dateInput,
  description: z.string().trim().min(1, 'Describe the entry').max(300),
  lines: z.array(journalLineInputSchema).min(2, 'A journal needs at least two lines').max(200),
});
export type JournalInput = z.infer<typeof journalInputSchema>;

export const reverseJournalSchema = z.object({
  entryDate: dateInput,
  reason: z.string().trim().min(3, 'Give a reason').max(200),
});

export const JOURNAL_SOURCES = {
  MANUAL: 'Manual journal',
  OPENING_BALANCE: 'Opening balances',
  YEAR_END: 'Year-end close',
  SALE: 'POS sale',
  CASHIER_SHIFT: 'Shift cash difference',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  GOODS_RECEIPT: 'Goods received',
  SUPPLIER_INVOICE: 'Supplier invoice',
  SUPPLIER_PAYMENT: 'Supplier payment',
  PURCHASE_RETURN: 'Return to supplier',
} as const;

/** Only entries made in the ledger itself can be reversed there; documents are corrected through their own screens. */
export const REVERSIBLE_SOURCES = ['MANUAL', 'OPENING_BALANCE'] as const;

export const journalListQuerySchema = listQuerySchema.extend({
  status: z.enum(['DRAFT', 'POSTED']).optional(),
  sourceType: z.string().max(40).optional(),
  accountId: z.uuid().optional(),
  from: dateInput.optional(),
  to: dateInput.optional(),
});

interface EntryRef {
  id: string;
  number: string | null;
}

export interface JournalSummary {
  id: string;
  number: string | null;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId: string | null;
  status: 'DRAFT' | 'POSTED';
  total: string;
  reversalOf: EntryRef | null;
  reversedBy: EntryRef | null;
  createdBy: string;
  createdAt: string;
  postedAt: string | null;
}

export interface JournalDetail extends JournalSummary {
  period: { id: string; name: string; status: 'OPEN' | 'CLOSED' };
  postedBy: string | null;
  lines: { lineNo: number; account: AccountRef; debit: string; credit: string; memo: string | null; location: string | null }[];
  totalDebit: string;
  totalCredit: string;
  /** Can be reversed here (a posted ledger entry that is not a reversal and not yet reversed). */
  reversible: boolean;
}

// ── Periods ───────────────────────────────────────────────────────────────

export const reopenPeriodSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(200) });

export interface PeriodRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  closedBy: string | null;
  draftJournals: number;
}

export interface FiscalYearRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  periods: PeriodRow[];
  closingEntry: EntryRef | null;
}

// ── Opening balances ──────────────────────────────────────────────────────

export const openingBalancesSchema = z.object({
  entryDate: dateInput,
  lines: z
    .array(z.object({ accountId: z.uuid(), debit: sideAmount, credit: sideAmount }))
    .max(500)
    .refine((ls) => ls.some((l) => !isZero(l.debit) || !isZero(l.credit)), 'Enter at least one balance'),
});
export type OpeningBalancesInput = z.infer<typeof openingBalancesSchema>;

export interface OpeningBalancesState {
  /** The posted opening-balance entry still in force, if any. */
  current: JournalDetail | null;
  /** Accounts that take an opening balance here (control accounts and Opening balance equity are excluded). */
  accounts: AccountRef[];
}

// ── Reports ───────────────────────────────────────────────────────────────

export const asOfQuerySchema = z.object({ asOf: dateInput.optional() });
export const rangeQuerySchema = z
  .object({ from: dateInput.optional(), to: dateInput.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'The start date must be on or before the end date', path: ['from'] });
export const ledgerQuerySchema = z
  .object({
    accountId: z.uuid('Choose an account'),
    from: dateInput.optional(),
    to: dateInput.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'The start date must be on or before the end date', path: ['from'] });

export interface LedgerLine {
  entryId: string;
  number: string;
  date: string;
  description: string;
  memo: string | null;
  sourceType: string;
  debit: string;
  credit: string;
  /** Running balance in the account's normal direction. */
  balance: string;
}

export interface GeneralLedger {
  account: AccountRef & { normal: 'DEBIT' | 'CREDIT' };
  from: string;
  to: string;
  openingBalance: string;
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  lines: LedgerLine[];
  meta: { page: number; pageSize: number; total: number };
}

export interface TrialBalance {
  asOf: string;
  rows: { account: AccountRef; debit: string; credit: string }[];
  totals: { debit: string; credit: string };
}

export interface ReportRow {
  account: AccountRef;
  amount: string;
}

export interface ReportSection {
  key: string;
  label: string;
  rows: ReportRow[];
  total: string;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: ReportSection;
  deductions: ReportSection;
  netSales: string;
  costOfSales: ReportSection;
  grossProfit: string;
  otherIncome: ReportSection;
  operatingExpenses: ReportSection;
  otherExpenses: ReportSection;
  netProfit: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: ReportSection[];
  totalAssets: string;
  liabilities: ReportSection[];
  totalLiabilities: string;
  equity: ReportSection;
  /** Income less expenses not yet closed to retained earnings (shown within equity). */
  currentEarnings: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

export interface CashFlowStatement {
  from: string;
  to: string;
  openingCash: string;
  operating: ReportSection;
  investing: ReportSection;
  financing: ReportSection;
  netChange: string;
  closingCash: string;
  cashAccounts: { account: AccountRef; opening: string; closing: string }[];
}

export interface ReceivablesAgingRow {
  customer: { id: string; code: string; name: string };
  days0to30: string;
  days31to60: string;
  days61to90: string;
  over90: string;
  balance: string;
}

export interface ReceivablesAging {
  asOf: string;
  rows: ReceivablesAgingRow[];
  totals: Omit<ReceivablesAgingRow, 'customer'>;
  /** Balance of the Accounts receivable ledger account on the same date (should equal totals.balance). */
  ledgerBalance: string;
}
