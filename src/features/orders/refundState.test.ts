import { expect, it } from "vitest";
import { isFullyRefunded } from "./refundState";

it("distinguishes a free paid order from a full refund", () => {
  expect(isFullyRefunded({ refunded_cents: 0, amount_total_cents: 0 })).toBe(false);
  expect(isFullyRefunded({ refunded_cents: 50, amount_total_cents: 100 })).toBe(false);
  expect(isFullyRefunded({ refunded_cents: 100, amount_total_cents: 100 })).toBe(true);
});
