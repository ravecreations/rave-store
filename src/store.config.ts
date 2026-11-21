import type { DeepPartial, SiteConfig } from "./config";

/**
 * RAVE Creations store settings — list ONLY what differs from the defaults in
 * `config.ts`. Values are deep-merged on top of them (arrays replace wholesale).
 *
 * Shipping here is only the default for a brand-new store; once shipping is
 * saved in Admin → Shipping, the Admin copy wins and this block is ignored.
 *
 * Operational switches and integrations belong in Admin → Settings.
 */
export const storeOverrides: DeepPartial<SiteConfig> = {
  storeName: "RAVE Creations",
  timeZone: "America/Phoenix",
  currency: "usd",
  shipping: {
    enabled: true,
    zones: [
      {
        name: "United States",
        countries: ["US"],
        rates: [
          { label: "Standard shipping", amountCents: 500 },
          {
            label: "Local pickup — Phoenix, AZ",
            pricing: { type: "pickup", amountCents: 0 },
          },
        ],
        // Free shipping once the subtotal reaches $50.
        freeOverCents: 5000,
      },
    ],
  },
};
