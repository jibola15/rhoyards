import { z } from 'zod';
import { listQuerySchema } from './api';
import { moneyInput, optionalText, positiveQtyInput } from './inputs';

// ── Reference data ────────────────────────────────────────────────────────

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo',
  'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa',
  'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
] as const;

// ── Customer accounts ─────────────────────────────────────────────────────

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(160));
const password = z.string().min(8, 'Use at least 8 characters').max(128);

export const customerRegisterSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(120),
  email,
  phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, 'Enter a valid phone number'),
  password,
});
export type CustomerRegisterInput = z.infer<typeof customerRegisterSchema>;

export const customerLoginSchema = z.object({ email, password: z.string().min(1, 'Enter your password').max(128) });

export interface StoreCustomer {
  id: string;
  name: string;
  email: string;
  phone: string | null;
}

export interface StoreSession {
  customer: StoreCustomer;
  csrfToken: string;
  expiresAt: string;
}

// ── Addresses ─────────────────────────────────────────────────────────────

export const addressSchema = z.object({
  recipient: z.string().trim().min(2, 'Enter the recipient').max(120),
  phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, 'Enter a valid phone number'),
  line1: z.string().trim().min(3, 'Enter the street address').max(200),
  line2: optionalText(200),
  city: z.string().trim().min(2, 'Enter the city or town').max(80),
  state: z.enum(NIGERIAN_STATES, 'Choose a state'),
});
export type AddressInput = z.infer<typeof addressSchema>;

export interface StoreAddress extends Omit<AddressInput, 'line2'> {
  id: string;
  line2: string | null;
  isDefault: boolean;
}

// ── Catalogue ─────────────────────────────────────────────────────────────

export const storeProductQuerySchema = listQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
  category: z.string().max(80).optional(),
  brand: z.string().max(80).optional(),
  minPrice: moneyInput.optional(),
  maxPrice: moneyInput.optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'price:asc', 'price:desc', 'name:asc']).optional(),
});

export type StockLevel = 'IN_STOCK' | 'LOW' | 'OUT';

export interface StoreProductCard {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  minPrice: string;
  maxPrice: string;
  compareAtPrice: string | null;
  inStock: boolean;
}

export interface StoreVariant {
  id: string;
  sku: string;
  name: string;
  shade: string | null;
  colour: string | null;
  size: string | null;
  volume: string | null;
  price: string;
  compareAtPrice: string | null;
  stock: StockLevel;
  /** Most that can be ordered now (capped for display). */
  maxQty: number;
}

export interface StoreProductDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  brand: { name: string; slug: string } | null;
  category: { name: string; slug: string } | null;
  images: { url: string; alt: string | null; variantId: string | null }[];
  variants: StoreVariant[];
  pricesIncludeTax: boolean;
}

export interface StoreFacets {
  categories: { slug: string; name: string; count: number }[];
  brands: { slug: string; name: string; count: number }[];
}

export interface StoreInfo {
  name: string;
  phone: string;
  email: string;
  address: string;
  currency: { code: string; symbol: string };
  pricesIncludeTax: boolean;
  onlineEnabled: boolean;
  providers: { code: PaymentProviderCode; name: string; description: string }[];
}

// ── Shipping ──────────────────────────────────────────────────────────────

export const shippingMethodInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: optionalText(300),
  fee: moneyInput,
  freeOver: z.union([moneyInput, z.literal(''), z.null()]).transform((v) => (v ? v : null)).optional(),
  /** Empty = delivers everywhere. */
  states: z.array(z.enum(NIGERIAN_STATES)).max(37).default([]),
  isPickup: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export const shippingMethodUpdateSchema = shippingMethodInputSchema.partial();

export interface ShippingMethodRow {
  id: string;
  name: string;
  description: string | null;
  fee: string;
  freeOver: string | null;
  states: string[];
  isPickup: boolean;
  isActive: boolean;
  sortOrder: number;
}

// ── Cart and checkout ─────────────────────────────────────────────────────

export const cartItemsSchema = z
  .array(z.object({ variantId: z.uuid(), qty: positiveQtyInput }))
  .min(1, 'Your cart is empty')
  .max(50, 'Too many items in one order');

export const cartQuoteSchema = z.object({
  items: cartItemsSchema,
  shippingMethodId: z.uuid().optional(),
  state: z.enum(NIGERIAN_STATES).optional(),
});

export const PAYMENT_PROVIDERS = ['MANUAL', 'TEST'] as const;
export type PaymentProviderCode = (typeof PAYMENT_PROVIDERS)[number];

export const checkoutSchema = z.object({
  items: cartItemsSchema,
  shippingMethodId: z.uuid('Choose a delivery option'),
  /** Required unless the shipping method is store pickup. */
  address: addressSchema.optional(),
  saveAddress: z.boolean().default(false),
  provider: z.enum(PAYMENT_PROVIDERS, 'Choose how to pay'),
  note: optionalText(500),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export type CartProblem = 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'INSUFFICIENT';

export interface CartQuoteLine {
  variantId: string;
  sku: string;
  name: string;
  productName: string;
  slug: string | null;
  imageUrl: string | null;
  qty: string;
  unitPrice: string;
  net: string;
  tax: string;
  total: string;
  /** Quantity that can be ordered now. */
  available: string;
  problem: CartProblem | null;
}

export interface CartQuote {
  lines: CartQuoteLine[];
  itemsTotal: string;
  shipping: { methodId: string; name: string; fee: string; isPickup: boolean } | null;
  /** Delivery options for the chosen state (all active ones if none chosen). */
  shippingOptions: (ShippingMethodRow & { feeForCart: string })[];
  subtotal: string;
  taxTotal: string;
  total: string;
  pricesIncludeTax: boolean;
  ok: boolean;
}

// ── Orders ────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'ON_HOLD', 'REFUNDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  PROCESSING: 'Processing',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On hold',
  REFUNDED: 'Refunded',
};

/** Fulfilment moves staff may make. Payment, cancellation and on-hold changes have their own actions. */
export const FULFILMENT_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PAID: ['PROCESSING'],
  PROCESSING: ['PACKED'],
  PACKED: ['SHIPPED', 'DELIVERED'],
  SHIPPED: ['DELIVERED'],
};

export const orderTransitionSchema = z.object({
  to: z.enum(['PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED']),
  note: optionalText(300),
  trackingReference: optionalText(80),
});
export const verifyPaymentSchema = z.object({
  reference: z.string().trim().min(3, 'Enter the transfer reference').max(80),
  note: optionalText(300),
});
export const cancelOrderSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });
/** Cancel a paid order: everything comes back to stock and the customer is refunded. */
export const refundOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(300),
  refundShipping: z.boolean().default(true),
  paymentMethodId: z.uuid().optional(),
  reference: optionalText(80),
});
export const refundDepositSchema = z.object({ paymentMethodId: z.uuid().optional(), reference: optionalText(80) });

export const orderListQuerySchema = listQuerySchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  customerId: z.uuid().optional(),
});

export interface OrderLine {
  lineNo: number;
  variantId: string;
  sku: string;
  description: string;
  qty: string;
  unitPrice: string;
  net: string;
  tax: string;
  total: string;
}

export interface OrderPayment {
  id: string;
  provider: PaymentProviderCode;
  reference: string;
  amount: string;
  status: 'INITIATED' | 'SUCCEEDED' | 'FAILED';
  verifiedAt: string | null;
  verifiedBy: string | null;
  createdAt: string;
}

export interface OrderHistoryEntry {
  from: OrderStatus | null;
  to: OrderStatus;
  at: string;
  by: string | null;
  note: string | null;
}

export interface StoreOrder {
  id: string;
  number: string;
  status: OrderStatus;
  placedAt: string;
  paidAt: string | null;
  reservedUntil: string | null;
  items: OrderLine[];
  itemsTotal: string;
  shipping: { name: string; isPickup: boolean; fee: string };
  subtotal: string;
  taxTotal: string;
  total: string;
  pricesIncludeTax: boolean;
  address: (Omit<StoreAddress, 'id' | 'isDefault'>) | null;
  trackingReference: string | null;
  payment: {
    provider: PaymentProviderCode;
    reference: string;
    status: OrderPayment['status'];
    /** Bank details for a transfer. */
    instructions: string | null;
    /** Where to send the customer to pay (test gateway). */
    redirectUrl: string | null;
  } | null;
  history: OrderHistoryEntry[];
  canCancel: boolean;
}

export interface OrderSummary {
  id: string;
  number: string;
  status: OrderStatus;
  customer: { id: string; name: string };
  itemCount: number;
  total: string;
  provider: PaymentProviderCode | null;
  placedAt: string;
  paidAt: string | null;
}

export interface OrderDetail extends StoreOrder {
  customer: { id: string; code: string; name: string; email: string | null; phone: string | null };
  location: { id: string; name: string };
  note: string | null;
  sale: { id: string; number: string } | null;
  payments: OrderPayment[];
  depositJournalId: string | null;
  depositRefundJournalId: string | null;
  returns: { id: string; number: string; status: string; total: string }[];
}

// ── Online-store settings ─────────────────────────────────────────────────

export const onlineSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Shown to customers paying by bank transfer. */
  bankTransferInstructions: z.string().trim().max(1000),
  /** How long stock stays reserved for an unpaid bank-transfer order. */
  transferHoldHours: z.number().int().min(1).max(168),
  /** How long stock stays reserved while a card payment is completed. */
  gatewayHoldMinutes: z.number().int().min(5).max(240),
});
