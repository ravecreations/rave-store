import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { listAllProducts } from "../../../features/products/db";
import { categoriesForProducts } from "../../../features/categories/db";
import { toCatalogProduct } from "../../../features/catalog/serialize";
import { catalogJson, catalogPreflight } from "../../../features/catalog/http";
import { getConfig } from "../../../config";
import { publicOrigin } from "../../../features/http/origin";
import { addCacheTags, productCacheTags } from "../../../features/cache/tags";

export const prerender = false;

export const OPTIONS: APIRoute = () => catalogPreflight();

const LIMIT = 4;
const ACTIVE = { where: "WHERE p.active = 1", params: [] as string[] };

/**
 * RAVE-specific (store-owned, not part of upstream minshop):
 * GET /api/rave/featured — what the marketing site's home page shows.
 *   newArrivals  newest active products
 *   bestSellers  most units sold in paid orders; ties (and a store with no
 *                sales yet) fall back to newest first
 * Same public shape as /api/products, with open CORS. Empty arrays mean "no
 * products": the marketing site then keeps its placeholder content.
 */
export const GET: APIRoute = async ({ url }) => {
  const origin = publicOrigin(url.origin, env.CANONICAL_ORIGIN);
  const [newest, best] = await Promise.all([
    listAllProducts(env.DB, LIMIT, 0, "p.created_at DESC, p.id DESC", ACTIVE),
    listAllProducts(env.DB, LIMIT, 0, "sold DESC, p.created_at DESC, p.id DESC", ACTIVE),
  ]);

  const all = [...newest, ...best];
  const categories = await categoriesForProducts(
    env.DB,
    all.map((p) => p.id),
  );
  const imageBaseUrl = getConfig().images.baseUrl;
  const serialize = (p: (typeof all)[number]) =>
    toCatalogProduct(
      p,
      (categories.get(p.id) ?? []).map((c) => c.name),
      origin,
      { imageBaseUrl },
    );

  const response = catalogJson({
    newArrivals: newest.map(serialize),
    // `best_seller` is true only for products with at least one paid sale, so
    // the site can avoid labelling unsold products. No exact counts are exposed.
    bestSellers: best.map((p) => ({ ...serialize(p), best_seller: p.sold > 0 })),
  });
  addCacheTags(response.headers, productCacheTags(all.map((p) => p.public_id)));
  return response;
};
