import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { cartCount, readCart, resolveCart } from "../../../features/cart/cart";
import { formatPrice } from "../../../config";

export const prerender = false;

/**
 * RAVE-specific (store-owned, not part of upstream minshop):
 * GET /api/rave/cart — the shopper's cart summary for the marketing site's Bag
 * button. ravecreations.art and shop.ravecreations.art are the same *site*, so
 * the browser sends the shop's (SameSite=Lax) cart cookie on a credentialed
 * fetch. CORS is therefore an exact-origin allowlist, never "*", and the
 * response is private. Only a count and a subtotal leave the shop — never the
 * cart contents.
 */
const ALLOWED_ORIGINS = new Set([
  "https://ravecreations.art",
  "https://www.ravecreations.art",
  "http://localhost:4327", // marketing-site dev server
]);

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin && ALLOWED_ORIGINS.has(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, OPTIONS",
        vary: "Origin",
      }
    : { vary: "Origin" };

export const OPTIONS: APIRoute = ({ request }) =>
  new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });

export const GET: APIRoute = async ({ request, cookies }) => {
  const cart = readCart(cookies);
  const count = cartCount(cart);
  const subtotal = count > 0 ? (await resolveCart(env.DB, cart)).subtotalCents : 0;
  return Response.json(
    { count, subtotal: count > 0 ? formatPrice(subtotal) : null },
    {
      headers: {
        ...corsHeaders(request.headers.get("origin")),
        "cache-control": "private, no-store",
      },
    },
  );
};
