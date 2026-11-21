---
name: manage-store-catalog
description: Manage, add, and update products and categories in the minshop / rave-store ecommerce catalog using the store MCP server tools and sync utilities. Use whenever the user wants to create, edit, browse, inspect, or manage products, pricing, stock, active status, images, or categories in the store.
---

# Manage Store Catalog (minshop MCP & Sync Utilities)

This skill guides adding and updating products, categories, and images in the store via the `rave-store` Model Context Protocol (MCP) server and the catalog sync script.

The store is based on [minshop](https://github.com/ddyy/minshop), a Cloudflare Workers + D1 ecommerce architecture where records are addressed externally via **prefixed public IDs** (`prod_...` for products, `cat_...` for categories, `ord_...` for orders, `med_...` for media, and `pimg_...` for product gallery images). Numeric database row IDs are strictly rejected across API and MCP boundaries.

---

## 1. Bulk Ingestion & Updating Script

For adding or updating products from local folders (such as folders containing `product.json` and product image files):

Use [`scripts/sync-products.mjs`](file:///Users/amanda/git/rave-store/scripts/sync-products.mjs):

```bash
# Sync products, categories, and upload/link missing images to remote production (default)
bun scripts/sync-products.mjs /path/to/PRODUCTS

# Or explicitly target local D1/R2
bun scripts/sync-products.mjs /path/to/PRODUCTS --local
```

### What `scripts/sync-products.mjs` Does:

1. **Idempotent Product Sync**: Connects to the store MCP server and creates new products or updates existing ones (`name`, `price_cents`, `stock`, `description`).
2. **Category Hierarchy**: Automatically registers any missing parent categories or subcategories in D1, then assigns the category associations to each product.
3. **Image Upload & Product Association**:
   - Reads image header bytes for dimensions (`width`, `height`).
   - Uploads new image files to Cloudflare R2 (`ravecreations-store-images/media/<hex>.<ext>`).
   - Inserts records into `media` and `product_images`.
   - Sets the product's primary image (`products.image_key`) so the storefront displays the product photo instead of the placeholder.

---

## 2. Available Store MCP Tools

The `rave-store` MCP server provides two tiers of tools:

### Operator Tier (Admin / Management)

Requires operator credentials (`Authorization: Bearer <MCP_TOKEN>`). Configured automatically in Antigravity, Claude, and ChatGPT Codex:

- `create_product`: Create a new product.
  - `name` (string, required): Product display name.
  - `price_cents` (integer, required): Price in integer minor units (e.g. `2500` for \$25.00).
  - `description` (string, optional): Product description.
  - `stock` (integer, optional, default: 0): Available inventory count.
  - `currency` (string, optional, default: "usd"): Currency code (lowercase).
  - `active` (boolean, optional, default: true): Whether product is visible on storefront.
  - _Returns_: `{ id: "prod_...", slug: "..." }`.

- `update_product`: Update an existing product.
  - `id` (string, required): `prod_...` public ID or existing product slug. Numeric IDs are rejected.
  - `name` (string, optional): Updated product name.
  - `price_cents` (integer, optional): Updated price in integer cents.
  - `description` (string or null, optional): Updated description.
  - `stock` (integer, optional): Updated inventory stock count.
  - `currency` (string, optional): Updated currency code.
  - `active` (boolean, optional): Set true to publish or false to unpublish/hide.
  - _Returns_: `{ id: "prod_...", slug: "..." }`.

- `list_products`: Paginate through catalog items (admin view: includes inactive products and sold counts).
  - `limit` (integer, optional, default: 50, max: 200).
  - `offset` (integer, optional, default: 0).
  - _Returns_: `{ products: [...], total: number, limit: number, offset: number }`.

- `get_product`: Retrieve detailed admin information for one product by its `prod_...` public ID or slug.
  - `id` (string, required): `prod_...` public ID or slug.

### Buyer Tier (Public Catalog & Storefront API)

Always accessible without credentials:

- `browse_products`: Search or list active, in-stock products with public pricing, URLs, image links, and assigned categories.
  - `q` (string, optional): Search query keyword.
  - `limit` (integer, optional).
  - `offset` (integer, optional).
- `get_product_details`: Retrieve full public details, including category associations, variants (`var_...`), and extras (`xtra_...`) by product slug.

---

## 3. Invariants & Rules

1. **Integer Minor Units for Money**:
   - Always supply `price_cents` as an integer minor unit (e.g., \$15.00 = `1500`, \$99.50 = `9950`).
   - Never pass decimal floating-point dollars to `price_cents`.

2. **Public IDs Only**:
   - Always use prefixed public IDs (`prod_...`, `cat_...`, `med_...`).
   - Product slugs can also be passed as `id` to `get_product` and `update_product`.
   - Never supply numeric database integer IDs; the MCP server will return an explicit error.

3. **Images**:
   - Products require an entry in `product_images` and an `image_key` referencing `media` to show a photo rather than the default placeholder.
