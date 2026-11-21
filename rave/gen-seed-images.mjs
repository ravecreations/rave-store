// Generates neon placeholder product images (rave/seed/images/*.webp) with sharp.
// Re-run with:  node rave/gen-seed-images.mjs
// These are stand-ins — replace them with real product photos in Admin → Media.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const SIZE = 800;
const OUT = new URL("./seed/images/", import.meta.url);
mkdirSync(OUT, { recursive: true });

// slug → [gradient from, gradient to, ring accent]
const PRODUCTS = {
  "blush-peony-silk-cuff": ["#ff37d5", "#ffb3ec", "#ffe566"],
  "wild-rose-ribbon-bracelet": ["#ff5fa8", "#7a1f6e", "#2cf7e9"],
  "midnight-orchid-wrap-bracelet": ["#1a0f3a", "#6a2cff", "#ff37d5"],
  "sapphire-jewel-silk-cuff": ["#0a1a4a", "#2c6bff", "#2cf7e9"],
  "neon-sunset-stack-set": ["#ff37d5", "#ffe566", "#2cf7e9"],
  "electric-citrus-silk-bracelet": ["#ffe566", "#2cf7e9", "#ff37d5"],
};

for (const [slug, [from, to, accent]] of Object.entries(PRODUCTS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 800 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.6">
      <stop offset="0" stop-color="#121214" stop-opacity="0"/><stop offset="1" stop-color="#121214" stop-opacity="0.4"/>
    </radialGradient>
  </defs>
  <rect width="800" height="800" fill="url(#bg)"/>
  <rect width="800" height="800" fill="url(#glow)"/>
  <circle cx="400" cy="400" r="190" fill="none" stroke="#121214" stroke-opacity="0.45" stroke-width="64"/>
  <circle cx="400" cy="400" r="190" fill="none" stroke="${accent}" stroke-width="22" stroke-dasharray="46 22"/>
  <circle cx="400" cy="400" r="226" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3"/>
  <circle cx="400" cy="400" r="154" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3"/>
</svg>`;
  await sharp(Buffer.from(svg))
    .webp({ quality: 82 })
    .toFile(new URL(`${slug}.webp`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  console.log("wrote", `${slug}.webp`);
}
