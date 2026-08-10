# Al-Fahad Ice System — Architecture

> Offline-first, multi-role PWA for ice factory operations.
> Stack: React + TypeScript + Vite + Supabase (Postgres + Realtime + Auth + Storage) + Dexie (IndexedDB) + Workbox.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (PWA)                            │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐     │
│  │   React UI   │──▶│  Domain Hooks│──▶│  Sync Engine     │     │
│  │  (role-aware)│   │   (RQ cache) │   │  (Outbox/Inbox)  │     │
│  └──────────────┘   └──────────────┘   └────────┬─────────┘     │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌──────────────────────────────────────────────────────┐       │
│  │   IndexedDB (Dexie)   │   Service Worker (Workbox)   │       │
│  │   - cache + outbox    │   - asset cache + bg-sync    │       │
│  └──────────────────────────────────────────────────────┘       │
└────────────────────────────┬────────────────────────────────────┘
                             │  HTTPS + WSS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                          SUPABASE                               │
│                                                                 │
│  Auth (JWT)   │  Postgres + RLS  │  Realtime  │  Edge Functions │
│               │  + triggers      │  (channels)│  (sensitive ops)│
└─────────────────────────────────────────────────────────────────┘
```

Two ironclad client-side rules:

1. **All mutations go through the Sync Engine** — never call Supabase directly from a UI handler. The engine decides: send immediately (online + permitted), queue in outbox (offline + allowed), or reject (offline + forbidden).
2. **Reads are always local-first.** UI reads from Dexie via `useLiveQuery`/TanStack Query; Realtime + initial pull keep Dexie hydrated.

---

## 2. User Roles

| Role               | Scope                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| `owner`            | Full access. All factories, all reports, all approvals.                              |
| `factory_manager`  | One factory. Manages inventory, approves production, approves loads, finishes trips. |
| `cashier`          | Receives cash from drivers. Approves cash collection from completed trips.           |
| `accountant`       | Read-only on operations. Full access to reports, customer balances, reconciliation.  |
| `driver`           | Assigned vehicle/trip only. Sales + returns offline. No inventory edits.             |

The role lives on `profiles`. RLS uses helper SQL functions `current_role()` and `current_factory()` that read from the row keyed by `auth.uid()`.

---

## 3. Database Schema (Supabase / Postgres)

Conventions:

- Every business entity has `id uuid PK` (client-generated for offline-created rows so the device can issue stable IDs without a round-trip).
- All client-originated rows therefore use their `id` as the **idempotency key** — `INSERT … ON CONFLICT (id) DO NOTHING` makes retries safe.
- Soft-deletes via `deleted_at` where appropriate. Append-only ledgers (`inventory_movements`) never delete.
- Timestamps: `created_at` / `updated_at` (auto via trigger).

### Core tables

- `factories`, `profiles`, `products`, `customers`, `vehicles`, `driver_vehicles`
- `price_lists`, `price_list_items`, `customer_price_lists`

### Inventory & production

- `inventory_balances` — derived state (factory × product → quantity)
- `vehicle_balances` — derived state (vehicle × product → quantity)
- `inventory_movements` — append-only ledger; **the single source of truth**. A trigger applies every insert to balances.
- `production_runs` — production logs, tied to an approval.

### Trips & vehicle loading

- `trips` (`planned | loaded | in_progress | closed | cancelled`)
- `vehicle_loads` — what was loaded onto the vehicle for this trip.

### Sales & returns

- `sales` (`pending | approved | rejected | void`), `sale_items`
- `returns` (`pending | approved | rejected`), `return_items`
- Both carry `client_created_at` (offline-captured).

### Approvals & reconciliation

- `approvals` — generic (`kind: cashier | production`, `status: pending | approved | rejected`)
- `cashier_reconciliations` — driver closing-cash vs received-cash with computed `variance`.

### Sync infrastructure

- `sync_operations` — server-side audit log of every client-issued op (idempotency + replay).

### Critical indexes

```sql
-- idempotency
alter table sales       add constraint sales_id_uniq      unique (id);
alter table returns     add constraint returns_id_uniq    unique (id);

-- one active trip per driver
create unique index one_active_trip_per_driver
  on trips(driver_id) where status in ('loaded','in_progress');

-- ledger query paths
create index inventory_movements_factory_idx on inventory_movements(factory_id, performed_at desc);
create index inventory_movements_vehicle_idx on inventory_movements(vehicle_id, performed_at desc);
```

### Server-side triggers (authority)

| Trigger                         | When                                  | Effect                                                                      |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `tg_set_updated_at`             | before update on most tables          | bumps `updated_at`                                                          |
| `tg_apply_movement`             | after insert on `inventory_movements` | atomically adjusts `inventory_balances` and/or `vehicle_balances`           |

All inventory changes flow through `inventory_movements`. RPCs (`process_sale`, `process_return`, `close_trip`, …) insert the appropriate rows; clients **never** write to balances directly.

---

## 4. Row-Level Security (RLS)

RLS is **on for every table**. Summary:

- `profiles` — read own + (manager/owner/accountant/cashier read peers). Self-update only.
- `products / customers / factories / vehicles / price_*` — readable by any authenticated user.
- `trips` — drivers see own; manager/owner/cashier/accountant see all. Drivers insert/update their own trips only.
- `sales / returns` — driver inserts only with `driver_id = auth.uid()`; reads own; manager/owner/cashier/accountant read all.
- `sale_items / return_items` — readable+writable iff parent is.
- `inventory_balances`, `vehicle_balances` — read-only to clients; mutated only by triggers.
- `inventory_movements` — read all; insert restricted to `owner / factory_manager / driver` (driver inserts only the load/return movements that an RPC creates on their behalf via `security definer`).
- `approvals` — anyone reads; only requester inserts; cashier-kind updated by `cashier/owner`, production-kind updated by `factory_manager/owner`.
- `sync_operations` — write-your-own; admins read all.

Sensitive transitions (approvals, trip close, transfers) ALSO go through **RPCs / Edge Functions** that re-verify role + state — RLS alone can't enforce multi-row transactional invariants.

---

## 5. Realtime Sync

| Channel             | Subscribers                | Purpose                                            |
| ------------------- | -------------------------- | -------------------------------------------------- |
| `factory:{id}`      | manager, cashier, owner    | inventory, production, loads, approvals            |
| `trip:{id}`         | driver of trip, manager    | trip status, finish-approval result                |
| `vehicle:{id}`      | driver, manager            | load changes pre-trip                              |
| `cashier:{factory}` | cashier, owner             | new cash collections + statuses                    |
| `user:{id}`         | self                       | profile / role changes, force-logout               |

On message: write to Dexie → Dexie's `liveQuery` updates UI. Drivers usually aren't subscribed during a trip (offline); they reconcile on reconnect via `pull-sync.ts`.

---

## 6. Offline-First Strategy

### Allowed offline

| Operation              | Offline | Why                                                   |
| ---------------------- | :-----: | ----------------------------------------------------- |
| View products / prices | ✅      | Cached at trip start                                  |
| View vehicle load      | ✅      | Snapshot at trip start                                |
| Create sale            | ✅      | Queued; deducts local vehicle_balance copy            |
| Create return          | ✅      | Queued                                                |
| **Finish trip**        | ❌      | Requires manager approval → online-only               |
| **Cashier approval**   | ❌      | Server-authoritative                                  |
| **Production approval**| ❌      | Server-authoritative                                  |
| **Vehicle transfer**   | ❌      | Multi-row transactional, server-only                  |
| **Edit main inventory**| ❌      | Server-only                                           |

Forbidden operations are **rejected at enqueue time** by the sync engine (`ONLINE_ONLY_OPERATIONS`). The UI also gates them with `<RequiresOnline>` so the affordance never appears offline.

### Outbox pattern

Every offline-allowed mutation:

1. UI calls `sales.create(payload)` (a feature-level fn).
2. Engine generates the operation `id` (UUIDv4) and writes:
   - The optimistic row(s) into Dexie tables.
   - An `OutboxOperation` into the `outbox` table.
3. UI updates instantly via `useLiveQuery`.
4. When online, `syncEngine.drain()` walks the outbox in **FIFO order** (`client_timestamp`).
5. Each op runs through its registered handler → calls a Supabase RPC.
6. RPCs are written `INSERT … ON CONFLICT (id) DO NOTHING` → idempotent replay safe.
7. On 2xx → outbox entry → `synced`, server response cached on the row.
8. On 4xx (validation) → `failed` with error surfaced to user, **no auto-retry**.
9. On 409 (state conflict) → `conflict` → entry written to `conflicts` table for review.
10. On 5xx / network → exponential backoff: **1s, 2.5s, 5s, 10s, 30s, 60s** (capped at 6 attempts).

Backoff is stored on the row as `next_attempt_at`, not slept on inside the
drain loop: `pickNext` skips ops that are not yet due and moves on to the
next one. A single failing op must never hold up the ops behind it — FIFO
is the ordering, not a barrier. After the last attempt the op becomes
`failed` and leaves the pending queue entirely (manual retry / discard in
the sync queue page).

Ops still marked `in_flight` at startup are orphans from a tab that was
closed mid-request; `syncEngine.start()` requeues them as `pending`.
Handlers are idempotent on the op id, so replay is safe.

### Sync triggers

- `online` window event
- App resume / `visibilitychange`
- Service worker `sync` event (Background Sync API) → posts message to client
- Manual "sync now" button
- After every successful auth refresh
- Periodic 5s heartbeat while the app is open

### Conflict resolution

- **Idempotency**: stable `id` UUID — duplicate sends are no-ops.
- **Server is authoritative on state**: e.g. if a return references a voided sale, server returns `409` and the operation goes to `conflicts`.
- **Vehicle load drift**: driver's local `vehicle_balances` is a snapshot. Server validates `sum(sold) ≤ quantity_loaded` on RPC; rejected sales surface to the driver.
- **No last-writer-wins on inventory**: balances are derived; only triggered by movements.
- **Pricing snapshot**: client embeds `unit_price` in `sale_items` — server-side price changes do not retroactively rewrite queued sales.

---

## 7. IndexedDB Structure (Dexie)

```ts
db.version(1).stores({
  // reference data (server snapshots)
  profiles:             'id, role, factory_id',
  products:             'id, sku, active',
  customers:            'id, code, region, active',
  price_list_items:     'id, [price_list_id+product_id], product_id',
  customer_price_lists: 'customer_id',
  vehicles:             'id, plate_number, factory_id',
  inventory_balances:   '[factory_id+product_id], factory_id, product_id',
  vehicle_balances:     '[vehicle_id+product_id], vehicle_id, product_id',

  // transactional (mix of server + locally created)
  trips:                'id, driver_id, vehicle_id, status, created_at',
  vehicle_loads:        'id, trip_id, product_id',
  sales:                'id, trip_id, status, client_created_at, synced_at',
  sale_items:           'id, sale_id, product_id',
  returns:              'id, trip_id, status, client_created_at, synced_at',
  return_items:         'id, return_id, product_id',
  approvals:            'id, kind, status, requested_by',

  // sync infra
  outbox:               'id, status, client_timestamp, entity_type, entity_id',
  conflicts:            'id, operation_id, resolved',
  meta:                 'key',
});
```

`client_timestamp` ordering ensures FIFO drain. The op `id` is the idempotency key.

`db.version(2)` adds `next_attempt_at` to outbox rows (retry backoff, see
§6). It is not indexed — the drain reads pending ops by `status` and gates
on the due time in memory.

---

## 8. Authentication Flow

1. **Login** — email + password via Supabase Auth → JWT (1h) + refresh token (7d). Session stored under key `alfahad.auth` in localStorage.
2. **Profile load** — `AuthProvider` calls `getSession()` → fetches `profiles` row → caches in Dexie.
3. **Offline hydrate** — on reload while offline, `AuthProvider` reads the cached profile from Dexie and restores `role` / `factory_id` so the role-routed shell still works.
4. **Role guard** — every protected route is wrapped in `<RequireRole roles={[...]}>`.
5. **Driver offline auth** —
   - Refresh token + profile persisted on first online login.
   - While offline, cached JWT honored until expiry (~1h).
   - If JWT expires offline, the driver enters degraded mode: writes still queue to outbox; a refresh is attempted on reconnect *before* draining.
6. **Force-logout** — server publishes `user:{id}` realtime event with `{ revoked: true }`; client clears Dexie + storage, redirects to `/login`.

---

## 9. Driver Offline Mode — Lifecycle

```
[Manager loads vehicle (online)] ──▶ [Approves load] ──▶ [Trip starts]
            ▼
[Driver opens app (online)] ─ pulls products, customers, prices, current trip, vehicle_load
            ▼
[Driver goes offline] ─ Sales/Returns queued; local vehicle_balance decremented optimistically
            ▼
[Driver returns online] ─ Engine: refresh JWT → drain outbox FIFO → realtime delta → conflicts surface
            ▼
[Driver requests "finish trip"] ─ MUST be online ─▶ creates trip-finish approval
            ▼
[Manager approves on their device] ─▶ [Server reconciles, trip closed]
```

Hard guard: the **Finish Trip** button is disabled when `!networkMonitor.isOnline()` *or* `outbox.pendingCount > 0`.

---

## 10. Conflict Prevention

| Layer                 | Mechanism                                                                   |
| --------------------- | --------------------------------------------------------------------------- |
| UUIDs                 | client-generated `id` (UUIDv4), UNIQUE in DB                                |
| Idempotent RPCs       | `INSERT … ON CONFLICT (id) DO NOTHING RETURNING …`                          |
| State machines        | trips/sales/returns/approvals have explicit status enums; transitions validated server-side |
| Server triggers       | inventory mutations originate from triggers, never client writes            |
| Pre-checks            | RPCs verify role + current state before mutating                            |
| Snapshots             | pricing, load qty, customer info captured at write time                     |
| Backoff retry         | exponential, capped, jittered — prevents stampede after outage              |
| Audit log             | every mutation logged in `sync_operations`                                  |
| Realtime invalidation | other clients update within ~1s of any change                               |

---

## 11. PWA / iOS

- **Manifest**: `display: standalone`, theme color, maskable icons (192/512).
- **iOS install**: documented Add-to-Home-Screen prompt + `apple-touch-icon`s + `apple-mobile-web-app-capable`.
- **Service worker** (Workbox via `injectManifest`):
  - Pre-cache app shell.
  - `NetworkOnly` for Supabase REST/Realtime — IndexedDB is the only offline source of truth for data; we never serve stale auth or data.
  - `StaleWhileRevalidate` for fonts and product images.
  - `BackgroundSync` notifies clients to drain outbox when JS context is dead.
- **Update flow**: SW emits `controllerchange` → toast "New version" → user-triggered `skipWaiting`.
- **Cold-start budget**: < 2s on 4G; route-level code splitting; vendor chunks split.

---

## 12. Folder Structure

```
src/
  app/                 App shell + providers
  components/          Shared UI components
    ui/                Atoms / primitives
    layout/            Headers, shells, navs
  features/            Feature folders by domain
    sales/  returns/  trips/  vehicles/  inventory/  approvals/
  hooks/               Reusable hooks
  lib/
    supabase/          Client singleton
    db/                Dexie schema + repos
    sync/              outbox engine + handlers + realtime + pull
    auth/              AuthProvider + permissions + role guards
    network/           connectivity monitor + RequiresOnline
    utils/
  pages/               Route components per role
    owner/  manager/  cashier/  accountant/  driver/
  routes/              Route config + role guards
  styles/
  types/               domain + sync types
  workers/             Service worker source

supabase/
  migrations/          SQL migrations
  functions/           Edge functions

docs/                  ARCHITECTURE.md (this file), RUNBOOK.md
```

---

## 13. Roadmap

- **Step 1 (this)** — architecture + scaffold + DB schema + core libs.
- **Step 2** — auth + role-aware routing + driver shell UI.
- **Step 3** — products / customers / inventory features + manager screens.
- **Step 4** — vehicle loading + trip lifecycle + approvals.
- **Step 5** — driver sales / returns offline + sync engine end-to-end.
- **Step 6** — cashier collection + reconciliation.
- **Step 7** — reports + audit + accountant.
- **Step 8** — hardening: e2e tests, monitoring, CI, RLS fuzz, conflict tests.
