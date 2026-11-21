# RAVE customizations on top of minshop

Everything RAVE-specific is isolated so upstream ([ddyy/minshop](https://github.com/ddyy/minshop)) can be merged in.

**Store-owned (upstream never edits these):**

- `src/themes/ravecreations-store/` — the RAVE theme (tokens, header, footer, cards, `site.ts` links back to ravecreations.art)
- `src/store.config.ts` — name, time zone, shipping defaults
- `theme.config.json`, `src/styles/overrides.css`
- `public/` brand assets: `brand/`, `fonts/`, favicon files
- `rave/` — seed data, placeholder-image tooling, deploy notes
- `test/scripts/rave.test.mjs`

**Small edits to upstream files (expect rare conflicts):**

- `wrangler.jsonc` — Worker/D1/R2 names (`ravecreations-store*`)
- `astro.config.mjs`, `scripts/check-themes.mjs` — Windows path fixes (each one commit; drop if upstream fixes them)
- `create-minshop/` is deleted (scaffold artifact)

## Pull upstream updates

```bash
git fetch upstream
git merge upstream/main        # or: git rebase upstream/main
npm install && bun run theme:sync && npm test && bun run check && bun run theme:check
bun run test:storefront-contract
```

If a contract test fails after an update, a control or model changed upstream: adjust the matching file in
`src/themes/ravecreations-store/` (see CUSTOMIZING.md). Never edit `src/themes/default|studio|market`.

## Local demo data

```bash
bun run provision:local
bunx wrangler d1 execute DB --local --file=./rave/seed.sql
bash rave/seed-images.sh
```
