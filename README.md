# Kiniku Card 💪🌱

Tiny workout tracker for two people, built on Cloudflare Workers + D1. Mark "workout" or "skip" for today and watch the grid grow. ✨

## Quick start 🚀
```txt
npm install
npm run dev
```

## Deploy ☁️
```txt
npm run deploy
```

## Config (optional) 🧩
Set default names via environment variables:
```txt
USER1=User1
USER2=User2
```

For local dev, add them to `.dev.vars`. For production, set them in `wrangler.jsonc` `vars` or via `wrangler secrets`/dashboard.

## Types (optional) 🧠
Generate/sync types from your Worker config:
```txt
npm run cf-typegen
```

Then pass `CloudflareBindings` to Hono:
```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
