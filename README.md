# Al-Fahad Ice System

Offline-first PWA for ice-factory operations: production, vehicle loading, driver trips, sales, returns, cashier reconciliation, and reporting.

## Stack

- **Frontend**: React 18 + TypeScript + Vite + React Router + TanStack Query + Zustand
- **Local DB**: Dexie (IndexedDB) — cache + outbox
- **Backend**: Supabase (Postgres + Auth + Realtime + Edge Functions)
- **PWA**: Workbox via `vite-plugin-pwa` (injectManifest)

## Quick start

```bash
pnpm install
cp .env.example .env.local        # fill VITE_SUPABASE_*
supabase start                    # if running locally
supabase db reset                 # apply migrations + seed
pnpm dev
```

## Roles

`owner`, `factory_manager`, `cashier`, `accountant`, `driver`. See `docs/ARCHITECTURE.md` §2.

## Offline policy

- ✅ Allowed offline: view products/customers/load, **create sale**, **create return**.
- ❌ Forbidden offline: **finish trip**, cashier approval, production approval, vehicle transfer, edit main inventory.

The Sync Engine refuses online-only operations when offline. See `docs/ARCHITECTURE.md` §6.

## Project structure

```
src/
  app/            App shell + providers
  routes/         Role-guarded route tree
  pages/          Top-level pages per role
  features/       Feature modules (sales, trips, returns, ...)
  components/     Shared UI
  lib/
    supabase/     Client singleton
    db/           Dexie schema + repos
    sync/         Sync engine + handlers + realtime + pull-sync
    auth/         AuthProvider + permissions + role guards
    network/      Online/offline monitor + RequiresOnline guard
  hooks/          Reusable hooks (live queries, etc.)
  types/          Domain + sync types
  workers/        Service worker source

supabase/
  migrations/     SQL migrations (schema + RLS + RPC)
  functions/      Edge functions (sensitive operations)

docs/             ARCHITECTURE.md (canonical design doc)
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full system design (read this first).

## Scripts

- `pnpm dev` — Vite dev server
- `pnpm build` — type-check + production build
- `pnpm typecheck` — TypeScript only
- `pnpm test` — Vitest
- `pnpm supabase:reset` — reset local DB and re-apply migrations
