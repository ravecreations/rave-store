export function isFullyRefunded(order: { refunded_cents: number; amount_total_cents: number }): boolean {
  return order.refunded_cents > 0 && order.refunded_cents >= order.amount_total_cents;
}
