import { Link } from 'react-router';
import type {
  GoodsReceiptSummary,
  PurchaseOrderSummary,
  PurchaseReturnSummary,
  SupplierInvoiceSummary,
  SupplierPaymentSummary,
} from '@rhoyards/shared';
import { DocumentList, type Column } from '../../components/DocumentList';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDate, formatMoney } from '../../lib/format';
import { DOC_STATUSES, INVOICE_STATUSES, PO_STATUSES } from './api';

const numberLink = (to: string, number: string) => (
  <Link to={to} className="font-mono text-sm font-medium hover:underline">
    {number}
  </Link>
);
const supplierLink = (s: { id: string; name: string }) => (
  <Link to={`/suppliers/${s.id}`} className="hover:underline">
    {s.name}
  </Link>
);
export function PurchaseOrdersPage() {
  const columns: Column<PurchaseOrderSummary>[] = [
    { header: 'Number', cell: (r) => numberLink(`/purchasing/orders/${r.id}`, r.number) },
    { header: 'Supplier', cell: (r) => supplierLink(r.supplier) },
    { header: 'Ordered', cell: (r) => formatDate(r.orderDate), className: 'hidden md:table-cell' },
    { header: 'Expected', cell: (r) => formatDate(r.expectedDate), className: 'hidden lg:table-cell' },
    { header: 'Total', cell: (r) => formatMoney(r.total), className: 'text-right tabular-nums' },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <DocumentList
      title="Purchase orders"
      description="What you have ordered from suppliers. Approve an order before receiving against it."
      queryKey="purchase-orders"
      path="/purchase-orders"
      statuses={PO_STATUSES}
      columns={columns}
      newLink={{ to: '/purchasing/orders/new', label: 'New order', permission: 'purchasing.manage' }}
    />
  );
}

export function GoodsReceiptsPage() {
  const columns: Column<GoodsReceiptSummary>[] = [
    { header: 'Number', cell: (r) => numberLink(`/purchasing/receipts/${r.id}`, r.number) },
    { header: 'Supplier', cell: (r) => supplierLink(r.supplier) },
    { header: 'Order', cell: (r) => (r.po ? numberLink(`/purchasing/orders/${r.po.id}`, r.po.number) : '—'), className: 'hidden md:table-cell' },
    { header: 'Received', cell: (r) => formatDate(r.receivedDate) },
    { header: 'Delivery note', cell: (r) => r.supplierRef ?? '—', className: 'hidden lg:table-cell' },
    { header: 'Value', cell: (r) => (r.status === 'POSTED' ? formatMoney(r.totalValue) : '—'), className: 'text-right tabular-nums' },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <DocumentList
      title="Goods received"
      description="Deliveries booked into stock. Posting adds the stock at the agreed cost."
      queryKey="goods-receipts"
      path="/goods-receipts"
      statuses={DOC_STATUSES}
      columns={columns}
      searchPlaceholder="Number, delivery note or supplier"
      newLink={{ to: '/purchasing/receipts/new', label: 'Receive without order', permission: 'purchasing.manage' }}
    />
  );
}

export function SupplierInvoicesPage() {
  const columns: Column<SupplierInvoiceSummary>[] = [
    { header: 'Number', cell: (r) => numberLink(`/purchasing/invoices/${r.id}`, r.number) },
    { header: 'Supplier', cell: (r) => supplierLink(r.supplier) },
    { header: 'Their ref', cell: (r) => <span className="font-mono text-xs">{r.supplierRef}</span> },
    { header: 'Due', cell: (r) => formatDate(r.dueDate), className: 'hidden md:table-cell' },
    { header: 'Total', cell: (r) => formatMoney(r.total), className: 'text-right tabular-nums' },
    { header: 'Outstanding', cell: (r) => formatMoney(r.outstanding), className: 'hidden text-right tabular-nums md:table-cell' },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <DocumentList
      title="Supplier invoices"
      description="Bills from suppliers, matched against goods received. Posting records what you owe."
      queryKey="supplier-invoices"
      path="/supplier-invoices"
      statuses={INVOICE_STATUSES}
      columns={columns}
      searchPlaceholder="Number, supplier invoice no. or supplier"
      newLink={{ to: '/purchasing/invoices/new', label: 'Enter invoice', permission: 'supplier_invoices.manage' }}
    />
  );
}

export function SupplierPaymentsPage() {
  const columns: Column<SupplierPaymentSummary>[] = [
    { header: 'Number', cell: (r) => numberLink(`/purchasing/payments/${r.id}`, r.number) },
    { header: 'Supplier', cell: (r) => supplierLink(r.supplier) },
    { header: 'Date', cell: (r) => formatDate(r.paymentDate) },
    { header: 'Paid from', cell: (r) => r.account.name, className: 'hidden md:table-cell' },
    { header: 'Reference', cell: (r) => r.reference ?? '—', className: 'hidden lg:table-cell' },
    { header: 'Amount', cell: (r) => formatMoney(r.amount), className: 'text-right tabular-nums' },
    { header: 'Unallocated', cell: (r) => (r.unallocated === '0.00' ? '—' : formatMoney(r.unallocated)), className: 'hidden text-right tabular-nums md:table-cell' },
  ];
  return (
    <DocumentList
      title="Supplier payments"
      description="Money paid to suppliers. Payments are final once recorded."
      queryKey="supplier-payments"
      path="/supplier-payments"
      columns={columns}
      searchPlaceholder="Number, reference or supplier"
      newLink={{ to: '/purchasing/payments/new', label: 'Record payment', permission: 'supplier_payments.manage' }}
    />
  );
}

export function PurchaseReturnsPage() {
  const columns: Column<PurchaseReturnSummary>[] = [
    { header: 'Number', cell: (r) => numberLink(`/purchasing/returns/${r.id}`, r.number) },
    { header: 'Supplier', cell: (r) => supplierLink(r.supplier) },
    { header: 'Receipt', cell: (r) => numberLink(`/purchasing/receipts/${r.receipt.id}`, r.receipt.number), className: 'hidden md:table-cell' },
    { header: 'Date', cell: (r) => formatDate(r.returnDate) },
    { header: 'Supplier credit', cell: (r) => (r.status === 'POSTED' ? formatMoney(r.creditTotal) : '—'), className: 'text-right tabular-nums' },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <DocumentList
      title="Returns to suppliers"
      description="Goods sent back. Start a return from the goods receipt it came in on."
      queryKey="purchase-returns"
      path="/purchase-returns"
      statuses={DOC_STATUSES}
      columns={columns}
    />
  );
}
