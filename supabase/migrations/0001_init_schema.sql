-- =====================================================================
-- Al-Fahad Ice — Initial schema
-- Designed for offline-first sync via UUID idempotency.
-- All client-originated rows use a client-generated `id` UUID; RPCs
-- INSERT ... ON CONFLICT (id) DO NOTHING for idempotent replay.
-- =====================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type user_role as enum (
  'owner',
  'factory_manager',
  'cashier',
  'accountant',
  'driver'
);

create type trip_status     as enum ('planned','loaded','in_progress','closed','cancelled');
create type sale_status     as enum ('pending','approved','rejected','void');
create type return_status   as enum ('pending','approved','rejected');
create type approval_kind   as enum ('cashier','production');
create type approval_status as enum ('pending','approved','rejected');
create type movement_kind   as enum (
  'production_in',
  'vehicle_load',
  'vehicle_unload',
  'sale_out',
  'return_in',
  'adjustment',
  'transfer'
);

-- ---------------------------------------------------------------------
-- Core entities
-- ---------------------------------------------------------------------
create table factories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text unique not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- profiles extends auth.users
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  role        user_role not null,
  factory_id  uuid references factories(id),
  phone       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table products (
  id          uuid primary key default gen_random_uuid(),
  sku         text unique not null,
  name        text not null,
  unit        text not null,                 -- bag, block, kg
  weight_kg   numeric(10,3),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table customers (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  name         text not null,
  phone        text,
  region       text,
  credit_limit numeric(12,2) not null default 0,
  balance      numeric(12,2) not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table price_lists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table price_list_items (
  id            uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references price_lists(id) on delete cascade,
  product_id    uuid not null references products(id) on delete restrict,
  unit_price    numeric(12,3) not null check (unit_price >= 0),
  unique (price_list_id, product_id)
);

create table customer_price_lists (
  customer_id   uuid primary key references customers(id) on delete cascade,
  price_list_id uuid not null references price_lists(id) on delete restrict
);

create table vehicles (
  id            uuid primary key default gen_random_uuid(),
  plate_number  text unique not null,
  label         text,
  capacity_kg   numeric(12,2),
  factory_id    uuid references factories(id),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table driver_vehicles (
  driver_id   uuid not null references profiles(id) on delete cascade,
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (driver_id, vehicle_id)
);

-- ---------------------------------------------------------------------
-- Inventory: event-sourced.
-- inventory_movements is the single source of truth.
-- balances tables are derived state, maintained by trigger.
-- ---------------------------------------------------------------------
create table inventory_balances (
  factory_id  uuid not null references factories(id) on delete cascade,
  product_id  uuid not null references products(id)  on delete restrict,
  quantity    numeric(14,3) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (factory_id, product_id)
);

create table vehicle_balances (
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  product_id  uuid not null references products(id) on delete restrict,
  quantity    numeric(14,3) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (vehicle_id, product_id)
);

create table inventory_movements (
  id              uuid primary key,                   -- client-generated UUID
  kind            movement_kind not null,
  product_id      uuid not null references products(id),
  quantity        numeric(14,3) not null check (quantity > 0),
  factory_id      uuid references factories(id),
  vehicle_id      uuid references vehicles(id),
  reference_id    uuid,                               -- sale_id, return_id, trip_id...
  reference_type  text,
  performed_by    uuid not null references profiles(id),
  performed_at    timestamptz not null default now(),
  note            text,
  created_at      timestamptz not null default now()
);

create index inventory_movements_factory_idx on inventory_movements(factory_id, performed_at desc);
create index inventory_movements_vehicle_idx on inventory_movements(vehicle_id, performed_at desc);

-- ---------------------------------------------------------------------
-- Trips, sales, returns
-- ---------------------------------------------------------------------
create table trips (
  id            uuid primary key,                     -- client-generated UUID
  driver_id     uuid not null references profiles(id),
  vehicle_id    uuid not null references vehicles(id),
  factory_id    uuid not null references factories(id),
  status        trip_status not null default 'planned',
  started_at    timestamptz,
  closed_at     timestamptz,
  opening_cash  numeric(12,2) not null default 0,
  closing_cash  numeric(12,2),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index trips_driver_idx on trips(driver_id, created_at desc);
-- one driver cannot have two simultaneously active trips
create unique index one_active_trip_per_driver
  on trips(driver_id) where status in ('loaded','in_progress');

create table vehicle_loads (
  id          uuid primary key,                       -- client-generated UUID
  trip_id     uuid not null references trips(id) on delete cascade,
  product_id  uuid not null references products(id),
  quantity    numeric(14,3) not null check (quantity > 0),
  loaded_by   uuid not null references profiles(id),
  loaded_at   timestamptz not null default now(),
  unique (trip_id, product_id)
);

create table sales (
  id                 uuid primary key,                -- client-generated UUID
  trip_id            uuid not null references trips(id) on delete cascade,
  customer_id        uuid references customers(id),
  driver_id          uuid not null references profiles(id),
  status             sale_status not null default 'pending',
  total_amount       numeric(12,2) not null default 0,
  paid_amount        numeric(12,2) not null default 0,
  payment_method     text,                            -- cash, credit, transfer
  client_created_at  timestamptz not null,            -- captured offline
  synced_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index sales_trip_idx   on sales(trip_id, client_created_at desc);
create index sales_status_idx on sales(status);

create table sale_items (
  id          uuid primary key,
  sale_id     uuid not null references sales(id) on delete cascade,
  product_id  uuid not null references products(id),
  quantity    numeric(14,3) not null check (quantity > 0),
  unit_price  numeric(12,3) not null check (unit_price >= 0),
  line_total  numeric(12,2) not null,
  unique (sale_id, product_id)
);

create table returns (
  id                 uuid primary key,
  trip_id            uuid not null references trips(id) on delete cascade,
  sale_id            uuid references sales(id),
  customer_id        uuid references customers(id),
  driver_id          uuid not null references profiles(id),
  status             return_status not null default 'pending',
  total_amount       numeric(12,2) not null default 0,
  reason             text,
  client_created_at  timestamptz not null,
  synced_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index returns_trip_idx on returns(trip_id, client_created_at desc);

create table return_items (
  id          uuid primary key,
  return_id   uuid not null references returns(id) on delete cascade,
  product_id  uuid not null references products(id),
  quantity    numeric(14,3) not null check (quantity > 0),
  unit_price  numeric(12,3) not null check (unit_price >= 0),
  line_total  numeric(12,2) not null
);

-- ---------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------
create table approvals (
  id              uuid primary key,
  kind            approval_kind not null,
  status          approval_status not null default 'pending',
  reference_id    uuid not null,
  reference_type  text not null,
  requested_by    uuid not null references profiles(id),
  reviewed_by     uuid references profiles(id),
  reviewed_at     timestamptz,
  amount          numeric(12,2),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index approvals_status_idx on approvals(kind, status, created_at desc);

create table cashier_reconciliations (
  id            uuid primary key,
  trip_id       uuid not null references trips(id) on delete cascade,
  driver_id     uuid not null references profiles(id),
  cashier_id    uuid not null references profiles(id),
  expected_cash numeric(12,2) not null,
  received_cash numeric(12,2) not null,
  variance      numeric(12,2) generated always as (received_cash - expected_cash) stored,
  approval_id   uuid references approvals(id),
  created_at    timestamptz not null default now()
);

create table production_runs (
  id          uuid primary key,
  factory_id  uuid not null references factories(id),
  product_id  uuid not null references products(id),
  quantity    numeric(14,3) not null check (quantity > 0),
  produced_at timestamptz not null default now(),
  approval_id uuid references approvals(id),
  notes       text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Sync infrastructure: server-side audit log of client operations
-- ---------------------------------------------------------------------
create table sync_operations (
  id                   uuid primary key,              -- the op UUID (client-generated)
  client_id            text not null,                 -- device id
  user_id              uuid not null references profiles(id),
  entity_type          text not null,
  entity_id            uuid not null,
  operation            text not null,                 -- create | update | delete | rpc:<name>
  payload              jsonb not null,
  client_timestamp     timestamptz not null,
  server_received_at   timestamptz not null default now(),
  applied              boolean not null default false,
  conflict             boolean not null default false,
  error                text
);

create index sync_operations_user_idx   on sync_operations(user_id, server_received_at desc);
create index sync_operations_entity_idx on sync_operations(entity_type, entity_id);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- updated_at maintenance
create or replace function tg_set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_profiles_updated  before update on profiles  for each row execute function tg_set_updated_at();
create trigger trg_trips_updated     before update on trips     for each row execute function tg_set_updated_at();
create trigger trg_sales_updated     before update on sales     for each row execute function tg_set_updated_at();
create trigger trg_returns_updated   before update on returns   for each row execute function tg_set_updated_at();
create trigger trg_approvals_updated before update on approvals for each row execute function tg_set_updated_at();

-- Inventory ledger → balance projection
create or replace function tg_apply_movement() returns trigger language plpgsql as $$
declare
  factory_delta numeric(14,3) := 0;
  vehicle_delta numeric(14,3) := 0;
begin
  -- factory side
  if new.factory_id is not null then
    factory_delta := case new.kind
      when 'production_in'   then  new.quantity
      when 'adjustment'      then  new.quantity
      when 'vehicle_unload'  then  new.quantity
      when 'vehicle_load'    then -new.quantity
      when 'transfer'        then -new.quantity
      else 0
    end;
    if factory_delta <> 0 then
      insert into inventory_balances(factory_id, product_id, quantity, updated_at)
      values (new.factory_id, new.product_id, factory_delta, now())
      on conflict (factory_id, product_id) do update
        set quantity   = inventory_balances.quantity + excluded.quantity,
            updated_at = now();
    end if;
  end if;

  -- vehicle side
  if new.vehicle_id is not null then
    vehicle_delta := case new.kind
      when 'vehicle_load'    then  new.quantity
      when 'return_in'       then  new.quantity
      when 'sale_out'        then -new.quantity
      when 'vehicle_unload'  then -new.quantity
      else 0
    end;
    if vehicle_delta <> 0 then
      insert into vehicle_balances(vehicle_id, product_id, quantity, updated_at)
      values (new.vehicle_id, new.product_id, vehicle_delta, now())
      on conflict (vehicle_id, product_id) do update
        set quantity   = vehicle_balances.quantity + excluded.quantity,
            updated_at = now();
    end if;
  end if;

  return new;
end $$;

create trigger trg_apply_movement
  after insert on inventory_movements
  for each row execute function tg_apply_movement();

-- ---------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------
create or replace function current_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function current_factory() returns uuid
language sql stable security definer set search_path = public as $$
  select factory_id from profiles where id = auth.uid()
$$;

-- ---------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------
alter table profiles                 enable row level security;
alter table factories                enable row level security;
alter table products                 enable row level security;
alter table customers                enable row level security;
alter table price_lists              enable row level security;
alter table price_list_items         enable row level security;
alter table customer_price_lists     enable row level security;
alter table vehicles                 enable row level security;
alter table driver_vehicles          enable row level security;
alter table inventory_balances       enable row level security;
alter table vehicle_balances         enable row level security;
alter table inventory_movements      enable row level security;
alter table trips                    enable row level security;
alter table vehicle_loads            enable row level security;
alter table sales                    enable row level security;
alter table sale_items               enable row level security;
alter table returns                  enable row level security;
alter table return_items             enable row level security;
alter table approvals                enable row level security;
alter table cashier_reconciliations  enable row level security;
alter table production_runs          enable row level security;
alter table sync_operations          enable row level security;

-- profiles: read self + peers (for staff roles); update self
create policy profiles_self_read on profiles for select using (
  id = auth.uid() or current_role() in ('owner','factory_manager','accountant','cashier')
);
create policy profiles_self_update on profiles for update using (id = auth.uid());

-- reference data: any authenticated user
create policy products_read              on products              for select using (auth.uid() is not null);
create policy customers_read             on customers             for select using (auth.uid() is not null);
create policy factories_read             on factories             for select using (auth.uid() is not null);
create policy vehicles_read              on vehicles              for select using (auth.uid() is not null);
create policy price_lists_read           on price_lists           for select using (auth.uid() is not null);
create policy price_list_items_read      on price_list_items      for select using (auth.uid() is not null);
create policy customer_price_lists_read  on customer_price_lists  for select using (auth.uid() is not null);
create policy driver_vehicles_read       on driver_vehicles       for select using (auth.uid() is not null);

-- trips: drivers see own; staff see all
create policy trips_read on trips for select using (
  driver_id = auth.uid() or current_role() in ('owner','factory_manager','cashier','accountant')
);
create policy trips_insert on trips for insert with check (
  driver_id = auth.uid() or current_role() in ('owner','factory_manager')
);
create policy trips_update on trips for update using (
  driver_id = auth.uid() or current_role() in ('owner','factory_manager','cashier')
);

-- sales: driver writes own; staff read all
create policy sales_read on sales for select using (
  driver_id = auth.uid() or current_role() in ('owner','factory_manager','cashier','accountant')
);
create policy sales_insert on sales for insert with check (driver_id = auth.uid());
create policy sales_update on sales for update using (
  driver_id = auth.uid() or current_role() in ('owner','factory_manager','cashier')
);

create policy sale_items_all on sale_items for all using (
  exists (select 1 from sales s where s.id = sale_items.sale_id
          and (s.driver_id = auth.uid()
               or current_role() in ('owner','factory_manager','cashier','accountant')))
);

-- returns
create policy returns_read on returns for select using (
  driver_id = auth.uid() or current_role() in ('owner','factory_manager','cashier','accountant')
);
create policy returns_insert on returns for insert with check (driver_id = auth.uid());
create policy returns_update on returns for update using (
  driver_id = auth.uid() or current_role() in ('owner','factory_manager','cashier')
);
create policy return_items_all on return_items for all using (
  exists (select 1 from returns r where r.id = return_items.return_id
          and (r.driver_id = auth.uid()
               or current_role() in ('owner','factory_manager','cashier','accountant')))
);

-- inventory: read for everyone; write only via trigger (no direct insert from clients except specific roles for adjustments)
create policy inv_balances_read       on inventory_balances     for select using (auth.uid() is not null);
create policy vehicle_balances_read   on vehicle_balances       for select using (auth.uid() is not null);
create policy inv_movements_read      on inventory_movements    for select using (auth.uid() is not null);
create policy inv_movements_insert    on inventory_movements    for insert with check (
  current_role() in ('owner','factory_manager','driver')
);

create policy vehicle_loads_read   on vehicle_loads for select using (auth.uid() is not null);
create policy vehicle_loads_insert on vehicle_loads for insert with check (
  current_role() in ('owner','factory_manager')
);

-- approvals: all read; requester inserts; cashier kind updated by cashier/owner; production by manager/owner
create policy approvals_read   on approvals for select using (auth.uid() is not null);
create policy approvals_insert on approvals for insert with check (requested_by = auth.uid());
create policy approvals_update on approvals for update using (
  (kind = 'cashier'    and current_role() in ('cashier','owner'))
  or (kind = 'production' and current_role() in ('factory_manager','owner'))
);

create policy production_runs_read   on production_runs for select using (auth.uid() is not null);
create policy production_runs_insert on production_runs for insert with check (
  current_role() in ('owner','factory_manager')
);

create policy cashier_recon_read   on cashier_reconciliations for select using (auth.uid() is not null);
create policy cashier_recon_insert on cashier_reconciliations for insert with check (
  current_role() in ('cashier','owner')
);

-- sync_operations: write-your-own; admins read
create policy sync_ops_insert on sync_operations for insert with check (user_id = auth.uid());
create policy sync_ops_read   on sync_operations for select using (
  user_id = auth.uid() or current_role() in ('owner','factory_manager')
);

-- ---------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table
  trips, sales, sale_items, returns, return_items,
  approvals, inventory_balances, vehicle_balances,
  vehicle_loads, production_runs, profiles;
