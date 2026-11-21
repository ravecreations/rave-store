import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { quoteShipping, FREE_SHIPPING_LABEL } from "../../src/features/shipping/calculator";
import { storeOverrides } from "../../src/store.config";

// RAVE store's build-time shipping defaults: US-only flat rate + Phoenix
// pickup, free shipping from $50.
const cfg = storeOverrides.shipping;
const quote = (subtotalCents, country = "US") =>
  quoteShipping(cfg, { subtotalCents, country, itemWeightGrams: 40 });

describe("RAVE shipping defaults", () => {
  it("offers standard shipping and free Phoenix pickup below $50", () => {
    const { options } = quote(4800);
    expect(options.map((o) => [o.label, o.amountCents, !!o.pickup])).toEqual([
      ["Standard shipping", 500, false],
      ["Local pickup — Phoenix, AZ", 0, true],
    ]);
  });

  it("adds free shipping once the subtotal reaches $50", () => {
    const labels = quote(5000).options.map((o) => o.label);
    expect(labels).toContain(FREE_SHIPPING_LABEL);
    expect(quote(5000).options.find((o) => o.label === FREE_SHIPPING_LABEL)?.amountCents).toBe(0);
    expect(quote(4999).options.map((o) => o.label)).not.toContain(FREE_SHIPPING_LABEL);
  });

  it("does not ship outside the US", () => {
    expect(quote(4200, "CA").options).toEqual([]);
  });
});

describe("seed.sql", () => {
  const sql = readFileSync(new URL("../../rave/seed.sql", import.meta.url), "utf8");

  it("creates the three collections the marketing site links to", () => {
    for (const slug of ["romantic-florals", "midnight-and-jewel", "color-pop-favorites"]) {
      expect(sql).toContain(`'${slug}'`);
    }
  });

  it("seeds six bracelets priced $38–$48", () => {
    const prices = [...sql.matchAll(/^\s+(\d{4}), \d+, 'products\/seed-/gm)].map((m) =>
      Number(m[1]),
    );
    expect(prices).toHaveLength(6);
    for (const cents of prices) {
      expect(cents).toBeGreaterThanOrEqual(3800);
      expect(cents).toBeLessThanOrEqual(4800);
    }
  });
});
