import { Badge, type BadgeProps } from '@rhoyards/ui';

const VARIANTS: Record<string, { label: string; variant: BadgeProps['variant'] }> = {
  DRAFT: { label: 'Draft', variant: 'outline' },
  POSTED: { label: 'Posted', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'secondary' },
  DISPATCHED: { label: 'In transit', variant: 'warning' },
  RECEIVED: { label: 'Received', variant: 'success' },
  APPROVED: { label: 'Approved', variant: 'secondary' },
  PARTIALLY_RECEIVED: { label: 'Partly received', variant: 'warning' },
  CLOSED: { label: 'Closed', variant: 'secondary' },
  OPEN: { label: 'Open', variant: 'success' },
  PENDING_PAYMENT: { label: 'Awaiting payment', variant: 'warning' },
  PROCESSING: { label: 'Processing', variant: 'secondary' },
  PACKED: { label: 'Packed', variant: 'secondary' },
  SHIPPED: { label: 'Shipped', variant: 'secondary' },
  DELIVERED: { label: 'Delivered', variant: 'success' },
  ON_HOLD: { label: 'On hold', variant: 'destructive' },
  INITIATED: { label: 'Pending', variant: 'outline' },
  SUCCEEDED: { label: 'Succeeded', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  REFUNDED: { label: 'Refunded', variant: 'secondary' },
  PENDING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  IN_PROGRESS: { label: 'In progress', variant: 'warning' },
  PARTIALLY_PAID: { label: 'Partly paid', variant: 'warning' },
  PAID: { label: 'Paid', variant: 'success' },
  ACTIVE: { label: 'Active', variant: 'success' },
  DISCONTINUED: { label: 'Discontinued', variant: 'secondary' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = VARIANTS[status] ?? { label: status, variant: 'outline' as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
