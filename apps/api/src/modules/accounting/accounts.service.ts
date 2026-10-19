import { Prisma, type Account } from '@prisma/client';
import { subtypeMatchesType, type AccountInput, type AccountRow, type AccountTypeCode, type AccountUpdate } from '@rhoyards/shared';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, businessRule, conflict, notFound } from '../../lib/errors';
import { getPrisma, transaction, type Db } from '../../lib/prisma';
import { isControlAccount, normalBalance, totalsByAccount } from './common';

const invalid = (message: string, field: string) => new AppError(400, 'VALIDATION_ERROR', message, { field });

function toRow(a: Account, balance: string, hasEntries: boolean): AccountRow {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    description: a.description,
    parentId: a.parentId,
    isPostable: a.isPostable,
    isActive: a.isActive,
    systemKey: a.systemKey,
    isControl: isControlAccount(a),
    balance,
    hasEntries,
  };
}

async function usage(db: Db, ids?: string[]) {
  const rows = await db.journalLine.groupBy({ by: ['accountId'], ...(ids ? { where: { accountId: { in: ids } } } : {}), _count: { _all: true } });
  return new Set(rows.map((r) => r.accountId));
}

/** The whole chart with posted balances (a small business has a few hundred accounts at most). */
export async function listAccounts(): Promise<AccountRow[]> {
  const prisma = getPrisma();
  const [accounts, totals, used] = await Promise.all([prisma.account.findMany({ orderBy: { code: 'asc' } }), totalsByAccount(prisma), usage(prisma)]);
  return accounts.map((a) => toRow(a, normalBalance(a.type, totals.get(a.id)).toFixed(2), used.has(a.id)));
}

async function accountRow(db: Db, id: string) {
  const a = await db.account.findUnique({ where: { id } });
  if (!a) throw notFound('Account');
  const [totals, used] = await Promise.all([totalsByAccount(db), usage(db, [id])]);
  return toRow(a, normalBalance(a.type, totals.get(id)).toFixed(2), used.has(id));
}

/** A parent groups accounts of the same type, and the tree may not loop. */
async function assertParent(db: Db, parentId: string | null | undefined, type: AccountTypeCode, selfId?: string) {
  if (!parentId) return;
  let cursor: string | null = parentId;
  for (let depth = 0; cursor; depth++) {
    if (cursor === selfId) throw invalid('An account cannot sit under itself', 'parentId');
    if (depth > 20) throw invalid('The account tree is too deep', 'parentId');
    const p: Pick<Account, 'type' | 'parentId'> | null = await db.account.findUnique({ where: { id: cursor }, select: { type: true, parentId: true } });
    if (!p) throw invalid('Parent account not found', 'parentId');
    if (depth === 0 && p.type !== type) throw invalid('The parent must be an account of the same type', 'parentId');
    cursor = p.parentId;
  }
}

const duplicateCode = (e: unknown, code: string) => {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return conflict(`Account code ${code} is already in use`, { field: 'code' });
  return e;
};

export async function createAccount(input: AccountInput, ctx: RequestContext): Promise<AccountRow> {
  return transaction(async (tx) => {
    await assertParent(tx, input.parentId, input.type);
    const a = await tx.account
      .create({
        data: {
          code: input.code,
          name: input.name,
          type: input.type,
          subtype: input.subtype,
          description: input.description ?? null,
          parentId: input.parentId ?? null,
          isPostable: input.isPostable,
        },
      })
      .catch((e: unknown) => {
        throw duplicateCode(e, input.code);
      });
    const row = toRow(a, '0.00', false);
    await writeAudit(tx, ctx, { action: 'account.created', entityType: 'account', entityId: a.id, after: row });
    return row;
  });
}

export async function updateAccount(id: string, input: AccountUpdate, ctx: RequestContext): Promise<AccountRow> {
  return transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM accounts WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked) throw notFound('Account');
    const before = await accountRow(tx, id);
    const isSystem = before.systemKey !== null;
    const type = input.type ?? before.type;
    const subtype = input.subtype ?? (input.type && input.type !== before.type ? null : before.subtype);

    if (input.type && input.type !== before.type) {
      if (isSystem) throw businessRule('The type of a system account cannot be changed');
      if (before.hasEntries) throw businessRule('This account has postings, so its type cannot be changed');
    }
    if (!subtype || !subtypeMatchesType(type, subtype)) throw invalid('Choose a classification that belongs to the account type', 'subtype');
    if (input.isPostable === false && before.isPostable) {
      if (isSystem) throw businessRule('System accounts must stay postable');
      if (before.hasEntries) throw businessRule('This account has postings, so it must stay postable');
    }
    if (input.isActive === false && before.isActive) {
      if (isSystem) throw businessRule('System accounts cannot be deactivated');
      if (before.balance !== '0.00') throw businessRule('Bring the balance to zero before deactivating this account');
      const [methods, taxes] = await Promise.all([
        tx.paymentMethod.count({ where: { accountId: id, isActive: true } }),
        tx.taxRate.count({ where: { OR: [{ outputAccountId: id }, { inputAccountId: id }] } }),
      ]);
      if (methods > 0) throw businessRule('An active payment method posts to this account');
      if (taxes > 0) throw businessRule('A tax rate posts to this account');
    }
    if (input.parentId !== undefined) await assertParent(tx, input.parentId, type, id);

    await tx.account
      .update({
        where: { id },
        data: {
          ...(input.code !== undefined ? { code: input.code } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          subtype,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.isPostable !== undefined ? { isPostable: input.isPostable } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      })
      .catch((e: unknown) => {
        throw duplicateCode(e, input.code ?? '');
      });
    const after = await accountRow(tx, id);
    await writeAudit(tx, ctx, { action: 'account.updated', entityType: 'account', entityId: id, before, after });
    return after;
  });
}
