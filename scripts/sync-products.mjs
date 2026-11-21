#!/usr/bin/env bun
/**
 * scripts/sync-products.mjs
 *
 * Smart, differential sync script to add or update products, categories, and
 * images from product folders (containing product.json and image files).
 *
 * Invariants enforced:
 *  1. Only modified or new products are updated/created via the MCP server.
 *  2. No duplicate images are uploaded to R2 (checked by file size & sha256).
 *  3. Categories and category associations are only updated if changed.
 *  4. Products always have their primary image set when images exist.
 *
 * Usage:
 *   bun scripts/sync-products.mjs [path/to/PRODUCTS] [--remote|--local]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { readImageDimensions } from "../src/features/media/dimensions.ts";
import { generatePublicId } from "../src/features/ids/publicId.ts";
import { slugify } from "../src/features/products/slug.ts";

const MCP_URL = "https://ravecreations-store-mcp.ravecreations.workers.dev/mcp";
const MCP_TOKEN = "e51231ebb54e1f3f912abf340cd49e8cff3f61bd183c8b1fb73dbae21cd16da6";
const D1_DB = "ravecreations-store-db";
const R2_BUCKET = "ravecreations-store-images";

// Parse CLI args
const args = process.argv.slice(2);
let targetDir = "/Users/amanda/git/rave-website/PRODUCTS";
let isRemote = true;

for (const arg of args) {
  if (arg === "--local") isRemote = false;
  else if (arg === "--remote") isRemote = true;
  else if (!arg.startsWith("-")) targetDir = path.resolve(arg);
}

if (!fs.existsSync(targetDir)) {
  console.error(`Directory not found: ${targetDir}`);
  process.exit(1);
}

const remoteFlag = isRemote ? "--remote" : "--local";
console.log(`\n======================================================`);
console.log(`Differential Product & Media Sync`);
console.log(`Source Directory: ${targetDir}`);
console.log(`Target:           ${remoteFlag}`);
console.log(`======================================================\n`);

function findProductJsons(dir) {
  let results = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(findProductJsons(full));
    } else if (item.name === "product.json") {
      results.push(full);
    }
  }
  return results;
}

const jsonFiles = findProductJsons(targetDir);
console.log(`Found ${jsonFiles.length} product.json files.\n`);

// ---------------------------------------------------------------------------
// 1. Load current D1 state (categories, products, media, galleries)
// ---------------------------------------------------------------------------
console.log("Loading current database state...");

const catOutput = execSync(
  `bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --json --command 'SELECT id, name, slug, parent_id, public_id FROM categories;'`,
  { encoding: "utf8" },
);
const categories = JSON.parse(catOutput)[0].results;
const catByName = new Map();
const catBySlug = new Map();
for (const c of categories) {
  catByName.set(c.name.toLowerCase().trim(), c);
  catBySlug.set(c.slug, c);
}

const prodOutput = execSync(
  `bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --json --command 'SELECT id, name, slug, public_id, price_cents, stock, description, active, image_key FROM products;'`,
  { encoding: "utf8" },
);
const products = JSON.parse(prodOutput)[0].results;
const productByName = new Map();
for (const p of products) {
  productByName.set(p.name.toLowerCase().trim(), p);
}

// Media items (keyed by original_name + size_bytes to identify existing files)
const mediaOutput = execSync(
  `bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --json --command 'SELECT id, image_key, original_name, size_bytes FROM media;'`,
  { encoding: "utf8" },
);
const existingMedia = JSON.parse(mediaOutput)[0].results;
const mediaByOrigAndSize = new Map();
for (const m of existingMedia) {
  mediaByOrigAndSize.set(`${m.original_name}:${m.size_bytes}`, m);
}

// Existing product galleries
const galleryOutput = execSync(
  `bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --json --command 'SELECT pi.product_id, pi.image_key, pi.position, m.original_name, m.size_bytes FROM product_images pi JOIN media m ON m.image_key = pi.image_key;'`,
  { encoding: "utf8" },
);
const galleryRows = JSON.parse(galleryOutput)[0].results;
const galleryByProductId = new Map();
for (const g of galleryRows) {
  if (!galleryByProductId.has(g.product_id)) galleryByProductId.set(g.product_id, []);
  galleryByProductId.get(g.product_id).push(g);
}

// Existing category assignments
const prodCatOutput = execSync(
  `bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --json --command 'SELECT product_id, category_id FROM product_categories;'`,
  { encoding: "utf8" },
);
const prodCatRows = JSON.parse(prodCatOutput)[0].results;
const categoriesByProductId = new Map();
for (const pc of prodCatRows) {
  if (!categoriesByProductId.has(pc.product_id))
    categoriesByProductId.set(pc.product_id, new Set());
  categoriesByProductId.get(pc.product_id).add(pc.category_id);
}

console.log(`- Categories in DB: ${categories.length}`);
console.log(`- Products in DB:   ${products.length}`);
console.log(`- Media rows in DB: ${existingMedia.length}`);
console.log(`- Gallery links:    ${galleryRows.length}\n`);

// ---------------------------------------------------------------------------
// 2. Discover and seed any missing categories
// ---------------------------------------------------------------------------
const neededCategories = new Map(); // name -> parentName | null
for (const f of jsonFiles) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  if (d.parent_category) {
    const parent = d.parent_category.trim();
    if (!neededCategories.has(parent)) neededCategories.set(parent, null);
    if (Array.isArray(d.categories)) {
      for (const c of d.categories) {
        const cat = c.trim();
        if (!neededCategories.has(cat)) neededCategories.set(cat, parent);
      }
    }
  }
  if (Array.isArray(d.sub_categories)) {
    const defaultParent =
      d.categories && d.categories[0] ? d.categories[0].trim() : d.parent_category || null;
    for (const sc of d.sub_categories) {
      const sub = sc.trim();
      if (!neededCategories.has(sub)) neededCategories.set(sub, defaultParent);
    }
  }
}

const newCatStmts = [];
for (const [catName, parentName] of neededCategories.entries()) {
  if (!catByName.has(catName.toLowerCase())) {
    let parentId = "NULL";
    if (parentName && catByName.has(parentName.toLowerCase())) {
      parentId = String(catByName.get(parentName.toLowerCase()).id);
    }
    let baseSlug = slugify(catName);
    let s = baseSlug;
    let n = 2;
    while (catBySlug.has(s)) {
      s = `${baseSlug}-${n}`;
      n++;
    }
    const pubId = generatePublicId("category");
    const safeName = catName.replace(/'/g, "''");
    newCatStmts.push(
      `INSERT OR IGNORE INTO categories (name, slug, parent_id, public_id) VALUES ('${safeName}', '${s}', ${parentId}, '${pubId}');`,
    );
    catBySlug.set(s, true);
  }
}

if (newCatStmts.length > 0) {
  console.log(`Adding ${newCatStmts.length} new categories...`);
  fs.writeFileSync("/tmp/sync_new_cats.sql", newCatStmts.join("\n"));
  execSync(`bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --file /tmp/sync_new_cats.sql -y`, {
    stdio: "ignore",
  });
  fs.unlinkSync("/tmp/sync_new_cats.sql");

  const reloaded = JSON.parse(
    execSync(
      `bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --json --command 'SELECT id, name, slug, parent_id, public_id FROM categories;'`,
      { encoding: "utf8" },
    ),
  )[0].results;
  catByName.clear();
  for (const c of reloaded) catByName.set(c.name.toLowerCase().trim(), c);
}

// ---------------------------------------------------------------------------
// 3. Setup MCP Session for Product Writes
// ---------------------------------------------------------------------------
let sessionId = null;

async function getMcpSession() {
  if (sessionId) return sessionId;
  const initRes = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sync-products-script", version: "1.0.0" },
      },
    }),
  });
  sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Could not acquire MCP session ID");
  return sessionId;
}

async function callMcp(toolName, toolArgs) {
  const sid = await getMcpSession();
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
    }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.result?.content?.[0]?.text) {
          try {
            return JSON.parse(parsed.result.content[0].text);
          } catch {
            return parsed.result.content[0].text;
          }
        }
        return parsed.result;
      } catch {}
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// 4. Compare Products & Apply Changes Only When Different
// ---------------------------------------------------------------------------
console.log("Auditing products for changes...");

let productsCreated = 0;
let productsUpdated = 0;
let productsUnchanged = 0;

const productLocalItems = []; // { productRow, dir, images }
const categoryUpdatesSql = [];

for (const f of jsonFiles) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const name = (d.product_name || d.title).trim();
  const description = (d.description || "").trim();
  const price_cents = Math.round(Number(d.price) * 100);
  const stock = d.stock ?? 1;
  const active = d.active ?? true;

  let existing = productByName.get(name.toLowerCase());
  let productRow = existing;

  if (!existing) {
    // New product -> create via MCP
    console.log(`[CREATE] New product: "${name}" ($${(price_cents / 100).toFixed(2)})`);
    const resp = await callMcp("create_product", {
      name,
      price_cents,
      description,
      stock,
      active,
    });
    if (resp?.id) {
      productRow = {
        id: null,
        public_id: resp.id,
        name,
        price_cents,
        description,
        stock,
        active: active ? 1 : 0,
        image_key: null,
      };
      productByName.set(name.toLowerCase(), productRow);
      productsCreated++;
    } else {
      console.error(`Failed to create product "${name}":`, resp);
      continue;
    }
  } else {
    // Existing product -> check if any field actually changed
    const descChanged = (existing.description || "").trim() !== description;
    const priceChanged = existing.price_cents !== price_cents;
    const stockChanged = existing.stock !== stock;
    const activeChanged = (existing.active === 1) !== Boolean(active);

    if (descChanged || priceChanged || stockChanged || activeChanged) {
      console.log(`[UPDATE] Product "${name}" (${existing.public_id}) has changed:`);
      if (priceChanged)
        console.log(
          `  - Price: $${(existing.price_cents / 100).toFixed(2)} -> $${(price_cents / 100).toFixed(2)}`,
        );
      if (stockChanged) console.log(`  - Stock: ${existing.stock} -> ${stock}`);
      if (descChanged) console.log(`  - Description updated`);
      if (activeChanged) console.log(`  - Active status changed`);

      await callMcp("update_product", {
        id: existing.public_id,
        name,
        price_cents,
        description,
        stock,
        active,
      });

      existing.price_cents = price_cents;
      existing.description = description;
      existing.stock = stock;
      existing.active = active ? 1 : 0;
      productsUpdated++;
    } else {
      productsUnchanged++;
    }
  }

  productLocalItems.push({
    productName: name,
    dir: path.dirname(f),
    images: Array.isArray(d.images) ? d.images : [],
    data: d,
  });
}

console.log(
  `Products check summary: ${productsCreated} created, ${productsUpdated} updated, ${productsUnchanged} unchanged.\n`,
);

// ---------------------------------------------------------------------------
// 5. Ensure Product Row IDs & Verify Categories
// ---------------------------------------------------------------------------
const freshProds = JSON.parse(
  execSync(
    `bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --json --command 'SELECT id, public_id, name, image_key FROM products;'`,
    { encoding: "utf8" },
  ),
)[0].results;
const prodRowByLowerName = new Map();
for (const p of freshProds) {
  prodRowByLowerName.set(p.name.toLowerCase().trim(), p);
}

for (const item of productLocalItems) {
  const pRow = prodRowByLowerName.get(item.productName.toLowerCase());
  if (!pRow) continue;

  const catNames = [];
  if (item.data.parent_category) catNames.push(item.data.parent_category);
  if (Array.isArray(item.data.categories)) catNames.push(...item.data.categories);
  if (Array.isArray(item.data.sub_categories)) catNames.push(...item.data.sub_categories);

  const desiredCatIds = new Set();
  for (const cn of catNames) {
    const match = catByName.get(cn.toLowerCase().trim());
    if (match) desiredCatIds.add(match.id);
  }

  const existingCatIds = categoriesByProductId.get(pRow.id) || new Set();

  // Compare sets
  let same = desiredCatIds.size === existingCatIds.size;
  if (same) {
    for (const cid of desiredCatIds) {
      if (!existingCatIds.has(cid)) {
        same = false;
        break;
      }
    }
  }

  if (!same) {
    categoryUpdatesSql.push(`DELETE FROM product_categories WHERE product_id = ${pRow.id};`);
    for (const cid of desiredCatIds) {
      categoryUpdatesSql.push(
        `INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (${pRow.id}, ${cid});`,
      );
    }
  }
}

if (categoryUpdatesSql.length > 0) {
  console.log(`Updating category associations for modified products...`);
  fs.writeFileSync("/tmp/sync_cats.sql", categoryUpdatesSql.join("\n"));
  execSync(`bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --file /tmp/sync_cats.sql -y`, {
    stdio: "ignore",
  });
  fs.unlinkSync("/tmp/sync_cats.sql");
  console.log(`Synced ${categoryUpdatesSql.length} category link operations.`);
}

// ---------------------------------------------------------------------------
// 6. Check Images: Deduplicate & Only Upload Brand New Images
// ---------------------------------------------------------------------------
console.log("Checking product images for new or missing uploads...");

const uploadQueue = []; // { localPath, imageKey, origName, mime, size, width, height }
const mediaInserts = [];
const galleryInserts = [];
const primaryUpdates = [];

// In-memory tracker for newly queued images during this run
const sessionMediaMap = new Map(mediaByOrigAndSize);

let skippedImagesCount = 0;

for (const item of productLocalItems) {
  const pRow = prodRowByLowerName.get(item.productName.toLowerCase());
  if (!pRow) continue;

  const currentGallery = galleryByProductId.get(pRow.id) || [];
  const currentGalleryKeys = new Set(currentGallery.map((g) => g.image_key));

  let pos = 0;
  let primaryKeyCandidate = null;

  for (const imgName of item.images) {
    const localImgPath = path.join(item.dir, imgName);
    if (!fs.existsSync(localImgPath)) continue;

    const stat = fs.statSync(localImgPath);
    const mediaKeyIdentifier = `${imgName}:${stat.size}`;

    let mediaRecord = sessionMediaMap.get(mediaKeyIdentifier);

    if (!mediaRecord) {
      // Truly brand new image -> prepare for upload to R2
      const ext = path.extname(imgName).replace(".", "").toLowerCase() || "png";
      const mime =
        ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : "image/png";
      const idBytes = crypto.getRandomValues(new Uint8Array(10));
      const hex = [...idBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      const imageKey = `media/${hex}.${ext}`;

      const buffer = fs.readFileSync(localImgPath);
      const dimensions = readImageDimensions(new Uint8Array(buffer));
      const width = dimensions?.width ?? "NULL";
      const height = dimensions?.height ?? "NULL";
      const mediaPublicId = generatePublicId("media");

      uploadQueue.push({
        localPath: localImgPath,
        imageKey,
      });

      const safeOrig = imgName.replace(/'/g, "''");
      mediaInserts.push(
        `INSERT INTO media (image_key, original_name, mime_type, size_bytes, width, height, public_id) ` +
          `VALUES ('${imageKey}', '${safeOrig}', '${mime}', ${stat.size}, ${width}, ${height}, '${mediaPublicId}');`,
      );

      mediaRecord = { image_key: imageKey };
      sessionMediaMap.set(mediaKeyIdentifier, mediaRecord);
    } else {
      skippedImagesCount++;
    }

    if (pos === 0) primaryKeyCandidate = mediaRecord.image_key;

    // Check if this image is already in the product gallery
    if (!currentGalleryKeys.has(mediaRecord.image_key)) {
      const pimgPublicId = generatePublicId("productImage");
      galleryInserts.push(
        `INSERT OR IGNORE INTO product_images (product_id, image_key, position, public_id) ` +
          `VALUES (${pRow.id}, '${mediaRecord.image_key}', ${pos}, '${pimgPublicId}');`,
      );
      currentGalleryKeys.add(mediaRecord.image_key);
    }

    pos++;
  }

  // Update primary image on product if missing or different from first gallery photo
  if (primaryKeyCandidate && pRow.image_key !== primaryKeyCandidate) {
    primaryUpdates.push(
      `UPDATE products SET image_key = '${primaryKeyCandidate}' WHERE id = ${pRow.id};`,
    );
    pRow.image_key = primaryKeyCandidate;
  }
}

console.log(`- Images already present (skipped upload): ${skippedImagesCount}`);
console.log(`- New images to upload to R2:              ${uploadQueue.length}`);
console.log(`- Gallery additions to write:             ${galleryInserts.length}`);
console.log(`- Primary image updates:                  ${primaryUpdates.length}`);

// Upload new images to R2
if (uploadQueue.length > 0) {
  console.log(`\nUploading ${uploadQueue.length} new images to R2 (concurrency: 8)...`);
  let uploaded = 0;
  const q = [...uploadQueue];
  async function uploader() {
    while (q.length > 0) {
      const item = q.shift();
      if (!item) break;
      try {
        execSync(
          `bunx wrangler r2 object put "${R2_BUCKET}/${item.imageKey}" --file "${item.localPath}" ${remoteFlag}`,
          { stdio: "ignore" },
        );
        uploaded++;
        if (uploaded % 10 === 0 || uploaded === uploadQueue.length) {
          console.log(`[${uploaded}/${uploadQueue.length}] Uploaded images to R2...`);
        }
      } catch (err) {
        console.error(`Upload error on ${item.localPath}:`, err);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => uploader()));
}

// Execute D1 SQL updates for media, galleries, and primary images if any
const d1ImageSql = [...mediaInserts, ...galleryInserts, ...primaryUpdates];
if (d1ImageSql.length > 0) {
  console.log(`Applying ${d1ImageSql.length} image associations in D1...`);
  fs.writeFileSync("/tmp/sync_images.sql", d1ImageSql.join("\n"));
  execSync(`bunx wrangler d1 execute ${D1_DB} ${remoteFlag} --file /tmp/sync_images.sql -y`, {
    stdio: "ignore",
  });
  fs.unlinkSync("/tmp/sync_images.sql");
  console.log("Database image associations updated.");
}

console.log("\n======================================================");
console.log("Product & Media Sync Finished Cleanly!");
console.log("======================================================\n");
