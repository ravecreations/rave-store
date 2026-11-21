import {
  isPendingInvoicePaid,
  pendingToPaidOrder,
  type PendingPayment,
} from "../lightning/pending";
import { getLightningBackend } from "../lightning";
import { recordPaidWebhookOrder } from "../../orders/recordWebhook";
import { resolveRequiredOrderEmail } from "../../email/orderPolicy";
import type { StoreSettings } from "../../settings/db";

// Settlement logic for the self-rendered /pay page, one function per method. Kept
// here (beside the views) so the route stays a thin dispatcher.

export interface DemoSettleResult {
  /** True once the order is recorded; the CALLER builds the redirect URL from
   *  its guest param — this module never emits a bare public-id URL. */
  settled?: boolean;
  declined?: string | null;
}

const DECLINE: Record<string, string> = {
  insufficient: "Payment declined — insufficient funds. (Simulated)",
  decline: "Payment declined — your card was declined. (Simulated)",
};

/**
 * Handle a demo-checkout POST. "approve" records a genuine order (tagged
 * payment_method='demo') through the same path the real webhooks use — emails,
 * stock, revenue, confirmation — and signals settled so the caller can redirect
 * to its guest order URL. Any other outcome returns a simulated decline message.
 */
export async function settleDemoCheckout(
  pending: PendingPayment,
  form: FormData,
  origin: string,
  settings?: StoreSettings,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<DemoSettleResult> {
  // Fail closed after the demo window even if a POST slips past the page guard.
  if (pending.expires_at != null && Date.parse(pending.expires_at) <= Date.now()) {
    return { declined: "This demo checkout has expired." };
  }
  const outcome = String(form.get("outcome") ?? "approve");
  const email = resolveRequiredOrderEmail(String(form.get("email") ?? ""), pending.email);
  if (!email) return { declined: "A valid email is required." };
  if (outcome === "approve") {
    const order = { ...pendingToPaidOrder(pending), email };
    // pendingToPaidOrder carries settlePaymentHash, so the pending row settles
    // inside the order batch — no separate markPendingSettled round trip. With
    // waitUntil the emails (and their reads) run after the redirect is sent.
    await recordPaidWebhookOrder({ type: "demo.paid", order }, origin, "demo", settings, waitUntil);
    return { settled: true };
  }
  return { declined: DECLINE[outcome] ?? DECLINE.decline };
}

/**
 * Settle-on-load for Lightning: poll the node directly (authoritative, so the page
 * works even with no public webhook). Records + marks settled when paid. Returns
 * true once settled so the caller can redirect to the order page.
 */
export async function settleLightningOnLoad(
  pending: PendingPayment,
  origin: string,
  settings?: StoreSettings,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<boolean> {
  if (pending.backend !== "lnbits" && pending.backend !== "phoenixd") return false;
  try {
    const backend = await getLightningBackend(pending.backend);
    const status = await backend.getIncoming(pending.payment_hash);
    if (!isPendingInvoicePaid(pending, status)) return false;
  } catch {
    return false;
  }
  await recordPaidWebhookOrder(
    { type: "lightning.paid", order: pendingToPaidOrder(pending) },
    origin,
    "lightning",
    settings,
    waitUntil,
  );
  return true;
}
