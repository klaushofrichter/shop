/**
 * The status a customer sees, derived from the order's parts (docs/design/07 §2.6).
 */
export interface StatusInput {
  payment_state: string;
  fulfilment_state: string;
  refunded_cents: number;
  shippedSomething: boolean;
}

export interface CustomerStatus {
  text: string;
  /** While the page should refresh itself (the payment is being confirmed). */
  waiting: boolean;
}

export function customerStatus(o: StatusInput): CustomerStatus {
  if (o.payment_state === 'checkout_open') return { text: 'Confirming your payment…', waiting: true };
  if (o.payment_state === 'closed_unpaid') return { text: 'Not paid', waiting: false };
  if (o.payment_state === 'refunded') return { text: o.shippedSomething ? 'Refunded — your item may still arrive' : 'Refunded', waiting: false };
  switch (o.fulfilment_state) {
    case 'none':
    case 'submitting':
    case 'draft':
    case 'confirming':
      return { text: "Payment received — we're checking your order", waiting: false };
    case 'submitted':
    case 'on_hold':
      return { text: 'In preparation', waiting: false };
    case 'in_production':
      return { text: 'In production', waiting: false };
    case 'partially_shipped':
    case 'shipped':
      return { text: 'Shipped', waiting: false };
    case 'delivered':
      return { text: 'Delivered', waiting: false };
    case 'test_draft_ok':
      return { text: 'Test order — nothing is produced', waiting: false };
    default:
      return { text: "Delayed — we're on it", waiting: false };
  }
}
