import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { dec, sum, ZERO, type Settings } from '@rhoyards/shared';
import type { StockSession } from '../../engines/inventory/inventory.engine';
import { postJournal, type JournalLineInput } from '../../engines/posting/posting.service';
import { businessDate } from '../../lib/business-date';
import { nextDocumentNumber } from '../../lib/sequences';

type Tx = Prisma.TransactionClient;
const money = (v: { toFixed(dp: number): string }) => new Prisma.Decimal(v.toFixed(2));

export type OrderForSale = Prisma.OnlineOrderGetPayload<{ include: { items: true } }>;

/**
 * Turns a paid online order into a completed sale (channel ONLINE) inside the caller's transaction: stock leaves at
 * the moving average (FEFO), and one journal posts the money received, revenue, delivery income, VAT and cost.
 * Prices are the ones fixed at checkout. The caller has already released the order's own reservation.
 *
 * `debit` is where the money is: the payment method's account when it has just arrived, or Customer deposits when
 * it was received earlier while the order was on hold.
 */
export async function createOnlineSale(
  tx: Tx,
  session: StockSession,
  order: OrderForSale,
  opts: { paymentMethodId: string; reference: string; debit: { accountId: string } | { accountKey: string }; actorId: string; settings: Settings },
) {
  const saleId = randomUUID();
  await tx.sale.create({
    data: {
      id: saleId,
      status: 'SUSPENDED',
      channel: 'ONLINE',
      locationId: order.locationId,
      customerId: order.customerId,
      cashierId: opts.actorId,
      pricesIncludeTax: order.pricesIncludeTax,
      note: `Online order ${order.number}`,
      items: {
        create: order.items.map((i) => ({
          lineNo: i.lineNo,
          variantId: i.variantId,
          sku: i.sku,
          description: i.description,
          qty: i.qty,
          unitPrice: i.unitPrice,
          listPrice: i.unitPrice,
          taxRateId: i.taxRateId,
          taxRate: i.taxRate,
          netAmount: i.netAmount,
          taxAmount: i.taxAmount,
          lineTotal: i.lineTotal,
        })),
      },
    },
  });
  const items = await tx.saleItem.findMany({ where: { saleId }, orderBy: { lineNo: 'asc' } });

  let costTotal = ZERO;
  for (const item of items) {
    const issue = await session.issue({
      variantId: item.variantId,
      locationId: order.locationId,
      qty: dec(item.qty.toString()),
      type: 'SALE',
      source: { type: 'SALE', id: saleId, lineId: item.id },
      expired: opts.settings.inventory.blockExpiredSale ? 'block' : 'allow',
    });
    costTotal = costTotal.plus(issue.totalCost);
    await tx.saleItem.update({ where: { id: item.id }, data: { unitCost: new Prisma.Decimal(issue.unitCost.toFixed(4)), costAmount: money(issue.totalCost) } });
  }

  await tx.salePayment.create({ data: { saleId, paymentMethodId: opts.paymentMethodId, amount: order.total, reference: opts.reference } });

  const itemsNet = sum(order.items.map((i) => i.netAmount.toString()));
  const number = await nextDocumentNumber(tx, 'SALE', 'S-');
  const lines: JournalLineInput[] = [{ ...opts.debit, debit: order.total.toString(), locationId: order.locationId }];
  if (itemsNet.gt(0)) lines.push({ accountKey: 'SALES_REVENUE', credit: itemsNet, locationId: order.locationId });
  if (order.shippingNet.gt(0)) lines.push({ accountKey: 'SHIPPING_INCOME', credit: order.shippingNet.toString(), locationId: order.locationId });
  if (order.taxTotal.gt(0)) lines.push({ accountKey: 'VAT_OUTPUT', credit: order.taxTotal.toString() });
  if (costTotal.gt(0)) {
    lines.push({ accountKey: 'COGS', debit: costTotal, locationId: order.locationId }, { accountKey: 'INVENTORY', credit: costTotal, locationId: order.locationId });
  }
  const journal = await postJournal(tx, {
    entryDate: businessDate(),
    sourceType: 'SALE',
    sourceId: saleId,
    postingKey: `SALE:${saleId}`,
    description: `Online sale ${number} (order ${order.number})`,
    lines,
    actorId: opts.actorId,
  });

  await tx.sale.update({
    where: { id: saleId },
    data: {
      status: 'COMPLETED',
      number,
      grossTotal: order.pricesIncludeTax ? order.total : order.subtotal,
      discountTotal: 0,
      subtotal: order.subtotal,
      taxTotal: order.taxTotal,
      total: order.total,
      amountPaid: order.total,
      balanceDue: 0,
      costTotal: money(costTotal),
      shippingAmount: order.shippingNet,
      journalEntryId: journal.id,
      completedAt: new Date(),
    },
  });
  return { saleId, number };
}
