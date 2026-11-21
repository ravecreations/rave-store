import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { createLightningProvider } from "./lightning-provider";
import type { IncomingStatus } from "./lightning/backend";
import { WebhookLookupError } from "./provider";

const pending = {
  backend: "phoenixd",
  payment_hash: "invoice-hash",
  public_id: "order-reference",
  amount_sat: 1000,
};

function provider(row: typeof pending | null) {
  const getIncoming = vi.fn<() => Promise<IncomingStatus>>();
  const adapter = createLightningProvider(
    {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    } as unknown as D1Database,
    {
      name: "phoenixd",
      createInvoice: vi.fn(),
      verifyWebhook: async () => ({ paymentHash: pending.payment_hash, paid: true }),
      getIncoming,
    },
  );
  return { verify: () => adapter.verifyWebhook("", new Headers()), getIncoming };
}

describe("Lightning settlement verification", () => {
  it.each([null, { ...pending, backend: "lnbits" }])(
    "skips node lookups for invoices outside this backend",
    async (row) => {
      const { verify, getIncoming } = provider(row);
      expect(await verify()).toEqual({ type: "lightning.unknown" });
      expect(getIncoming).not.toHaveBeenCalled();
    },
  );

  it("requires the expected amount when the node supplies it", async () => {
    const { verify, getIncoming } = provider(pending);
    getIncoming.mockResolvedValueOnce({ paid: true, amountSat: 999 });
    expect(await verify()).toEqual({ type: "lightning.unconfirmed" });
    getIncoming.mockResolvedValueOnce({ paid: true, amountSat: 1000 });
    expect(await verify()).toMatchObject({
      type: "lightning.paid",
      order: { providerSessionId: pending.payment_hash },
    });
  });

  it("marks lookup outages as retryable", async () => {
    const { verify, getIncoming } = provider(pending);
    getIncoming.mockRejectedValueOnce(new Error("Node unavailable"));
    await expect(verify()).rejects.toBeInstanceOf(WebhookLookupError);
  });
});
