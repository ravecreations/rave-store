import { afterEach, describe, it, expect, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createOpenNodeProvider } from "./opennode";
import { WebhookLookupError } from "./provider";

const KEY = "opennode-api-key";
const CHARGE_ID = "charge-123";

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const pendingRow = {
  id: 1,
  public_id: "pub-1",
  payment_hash: CHARGE_ID,
  backend: "opennode",
  bolt11: null,
  amount_sat: null,
  amount_total_cents: 4200,
  currency: "usd",
  email: null,
  items: JSON.stringify([{ id: 7, q: 2, n: "Mug", p: 2100 }]),
  reservation_id: null,
  status: "pending",
  expires_at: null,
  created_at: "2026-06-17 00:00:00",
};

// Minimal D1 stand-in: SELECT returns the pending row, UPDATE is a no-op.
function fakeDb(row: unknown): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => (sql.trimStart().toUpperCase().startsWith("SELECT") ? row : null),
            run: async () => ({}),
          };
        },
      };
    },
  } as unknown as D1Database;
}

function webhookBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe("OpenNode provider — verifyWebhook", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockChargeStatus(status: string) {
    const fetchCharge = vi.fn(async () => Response.json({ data: { id: CHARGE_ID, status } }));
    vi.stubGlobal("fetch", fetchCharge);
    return fetchCharge;
  }

  it("accepts a correctly-signed paid webhook and returns the order from pending", async () => {
    const fetchCharge = mockChargeStatus("paid");
    const provider = createOpenNodeProvider(fakeDb(pendingRow), KEY);
    const payload = webhookBody({
      id: CHARGE_ID,
      status: "paid",
      hashed_order: await hmacHex(KEY, CHARGE_ID),
    });
    const result = await provider.verifyWebhook(payload, new Headers());
    expect(fetchCharge).toHaveBeenCalledWith(`https://api.opennode.com/v2/charge/${CHARGE_ID}`, {
      headers: { Authorization: KEY },
      redirect: "error",
    });
    expect(result.type).toBe("opennode.paid");
    expect(result.order?.providerSessionId).toBe(CHARGE_ID);
    expect(result.order?.amountTotalCents).toBe(4200);
    expect(result.order?.reservationId).toBeUndefined();
    expect(result.order?.items).toEqual([
      { productId: 7, variantId: null, name: "Mug", priceCents: 2100, quantity: 2 },
    ]);
  });

  it("links only new pending payments to an explicit inventory reservation", async () => {
    mockChargeStatus("paid");
    const provider = createOpenNodeProvider(
      fakeDb({ ...pendingRow, reservation_id: "reservation-1" }),
      KEY,
    );
    const payload = webhookBody({
      id: CHARGE_ID,
      status: "paid",
      hashed_order: await hmacHex(KEY, CHARGE_ID),
    });
    const result = await provider.verifyWebhook(payload, new Headers());
    expect(result.order?.reservationId).toBe("reservation-1");
  });

  it("rejects a forged signature", async () => {
    const provider = createOpenNodeProvider(fakeDb(pendingRow), KEY);
    const payload = webhookBody({ id: CHARGE_ID, status: "paid", hashed_order: "deadbeef" });
    await expect(provider.verifyWebhook(payload, new Headers())).rejects.toThrow();
  });

  it("does not produce an order for a non-paid status", async () => {
    mockChargeStatus("processing");
    const provider = createOpenNodeProvider(fakeDb(pendingRow), KEY);
    const payload = webhookBody({
      id: CHARGE_ID,
      hashed_order: await hmacHex(KEY, CHARGE_ID),
    });
    const result = await provider.verifyWebhook(payload, new Headers());
    expect(result.order).toBeUndefined();
    expect(result.type).toBe("opennode.processing");
  });

  it("releases the linked hold when the charge lookup confirms expiry", async () => {
    mockChargeStatus("expired");
    const provider = createOpenNodeProvider(
      fakeDb({ ...pendingRow, reservation_id: "reservation-1" }),
      KEY,
    );
    const payload = webhookBody({ id: CHARGE_ID, hashed_order: await hmacHex(KEY, CHARGE_ID) });
    expect(await provider.verifyWebhook(payload, new Headers())).toEqual({
      type: "opennode.expired",
      releaseReservationId: "reservation-1",
    });
  });

  it("reports lookup failures as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const provider = createOpenNodeProvider(fakeDb(pendingRow), KEY);
    const payload = webhookBody({ id: CHARGE_ID, hashed_order: await hmacHex(KEY, CHARGE_ID) });
    await expect(provider.verifyWebhook(payload, new Headers())).rejects.toBeInstanceOf(
      WebhookLookupError,
    );
  });
});
