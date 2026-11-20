import type { D1Database } from '@cloudflare/workers-types';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createStripeProvider } from './stripe';

const secret = 'stripe-test-webhook-secret';
const stripe = new Stripe('sk_test_example');
const reservationId = 'ord_0123456789';

async function paidEvent(metadata: Record<string, string>) {
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_example',
        metadata,
        payment_status: 'paid',
        amount_total: 1200,
        currency: 'usd',
      },
    },
  });
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return [payload, new Headers({ 'stripe-signature': signature })] as const;
}

describe('Stripe checkout ownership', () => {
  function provider(reservation: { found: number } | null) {
    const first = vi.fn(async () => reservation);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const adapter = createStripeProvider({ prepare } as unknown as D1Database, 'sk_test_example', secret);
    return { adapter, prepare, bind };
  }

  it('ignores unrelated Checkout Sessions without searching for a reservation', async () => {
    const { adapter, prepare } = provider(null);
    expect((await adapter.verifyWebhook(...await paidEvent({}))).order).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('requires the reported checkout to reference a local Stripe reservation', async () => {
    const event = await paidEvent({ public_id: reservationId, reservation_id: reservationId });
    const unknown = provider(null);
    expect((await unknown.adapter.verifyWebhook(...event)).order).toBeUndefined();
    const local = provider({ found: 1 });
    expect((await local.adapter.verifyWebhook(...event)).order).toMatchObject({
      providerSessionId: 'cs_test_example',
      publicId: reservationId,
      reservationId,
    });
    expect(local.bind).toHaveBeenCalledWith(reservationId);
  });
});
