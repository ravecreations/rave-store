import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getPaymentProvider,
  isMethodAvailable,
  type PaymentMethod,
} from '../../../features/payments';
import { getStoreSettings } from '../../../features/settings/db';
import { recordPaidWebhookOrder } from '../../../features/orders/recordWebhook';
import { MAX_WEBHOOK_BYTES, WebhookLookupError } from '../../../features/payments/provider';
import { readBoundedText } from '../../../features/http/requestBody';

export const prerender = false;

const METHODS: PaymentMethod[] = ['stripe', 'lightning', 'opennode'];

// Per-provider webhook: POST /api/webhook/<method>. Lets multiple rails run at
// once — each posts to its OWN path, because a single endpoint can only verify
// one provider's signature. Point each provider's webhook config at its path
// (Stripe dashboard → /api/webhook/stripe, the Lightning mint → /api/webhook/lightning).
export const POST: APIRoute = async ({ request, params }) => {
  const method = params.provider as PaymentMethod;
  const settings = await getStoreSettings(env.DB);
  if (!METHODS.includes(method) || !isMethodAvailable(method, settings)) {
    return new Response('Unknown or unconfigured payment method', { status: 404 });
  }

  const payload = await readBoundedText(request, MAX_WEBHOOK_BYTES).catch(() => undefined);
  if (payload === undefined) return new Response('Invalid request body', { status: 400 });
  if (payload === null) return new Response('Webhook body is too large', { status: 413 });
  const origin = new URL(request.url).origin;

  let result;
  try {
    const provider = await getPaymentProvider(method);
    result = await provider.verifyWebhook(payload, request.headers);
  } catch (err) {
    if (err instanceof WebhookLookupError) {
      return new Response('Payment provider temporarily unavailable', { status: 503 });
    }
    return new Response(`Webhook verification failed: ${(err as Error).message}`, { status: 400 });
  }

  await recordPaidWebhookOrder(result, origin, method, settings);
  return new Response('ok', { status: 200 });
};
