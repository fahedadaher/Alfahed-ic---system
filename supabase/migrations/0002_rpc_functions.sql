-- =====================================================================
-- Al-Fahad Ice — RPC functions
-- All RPCs use ON CONFLICT (id) DO NOTHING for idempotent replay.
-- All RPCs are SECURITY DEFINER so they can write to inventory_movements
-- on behalf of drivers (RLS allows driver insert there only via these).
-- =====================================================================

-- ---------------------------------------------------------------------
-- process_sale
-- Inserts the sale + items + outbound movement in one transaction.
-- Validates that the vehicle has enough stock for the requested items.
-- Idempotent on sale.id.
-- ---------------------------------------------------------------------
create or replace function process_sale(
  p_sale_id           uuid,
  p_trip_id           uuid,
  p_customer_id       uuid,
  p_payment_method    text,
  p_paid_amount       numeric,
  p_client_created_at timestamptz,
  p_items             jsonb        -- [{product_id, quantity, unit_price}]
) returns sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale       sales;
  v_trip       trips;
  v_total      numeric(12,2) := 0;
  v_item       jsonb;
  v_qty        numeric(14,3);
  v_price      numeric(12,3);
  v_pid        uuid;
  v_available  numeric(14,3);
begin
  -- existing? (idempotent replay)
  select * into v_sale from sales where id = p_sale_id;
  if found then
    return v_sale;
  end if;

  select * into v_trip from trips where id = p_trip_id for update;
  if not found then
    raise exception 'TRIP_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_trip.driver_id <> auth.uid() then
    raise exception 'NOT_OWNER_OF_TRIP' using errcode = '42501';
  end if;
  if v_trip.status not in ('loaded','in_progress') then
    raise exception 'TRIP_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  -- compute total + validate stock
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid   := (v_item->>'product_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;

    select coalesce(quantity, 0) into v_available
      from vehicle_balances
      where vehicle_id = v_trip.vehicle_id and product_id = v_pid;

    if v_available is null or v_available < v_qty then
      raise exception 'INSUFFICIENT_STOCK:%', v_pid using errcode = 'P0003';
    end if;

    v_total := v_total + (v_qty * v_price);
  end loop;

  -- insert sale
  insert into sales(
    id, trip_id, customer_id, driver_id, status,
    total_amount, paid_amount, payment_method,
    client_created_at, synced_at
  ) values (
    p_sale_id, p_trip_id, p_customer_id, auth.uid(), 'pending',
    v_total, coalesce(p_paid_amount, 0), p_payment_method,
    p_client_created_at, now()
  ) returning * into v_sale;

  -- insert items
  insert into sale_items(id, sale_id, product_id, quantity, unit_price, line_total)
  select
    gen_random_uuid(),
    p_sale_id,
    (item->>'product_id')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    ((item->>'quantity')::numeric * (item->>'unit_price')::numeric)
  from jsonb_array_elements(p_items) as item;

  -- emit sale_out movements (one per product) → trigger updates vehicle_balances
  insert into inventory_movements(id, kind, product_id, quantity, vehicle_id,
                                  reference_id, reference_type, performed_by)
  select
    gen_random_uuid(),
    'sale_out',
    (item->>'product_id')::uuid,
    (item->>'quantity')::numeric,
    v_trip.vehicle_id,
    p_sale_id,
    'sale',
    auth.uid()
  from jsonb_array_elements(p_items) as item;

  -- transition trip from loaded → in_progress on first sale
  if v_trip.status = 'loaded' then
    update trips set status = 'in_progress', started_at = coalesce(started_at, now())
    where id = p_trip_id;
  end if;

  return v_sale;
end $$;

-- ---------------------------------------------------------------------
-- process_return
-- Idempotent on return.id. Emits return_in movement (back into vehicle).
-- ---------------------------------------------------------------------
create or replace function process_return(
  p_return_id         uuid,
  p_trip_id           uuid,
  p_sale_id           uuid,
  p_customer_id       uuid,
  p_reason            text,
  p_client_created_at timestamptz,
  p_items             jsonb
) returns returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret    returns;
  v_trip   trips;
  v_total  numeric(12,2) := 0;
begin
  select * into v_ret from returns where id = p_return_id;
  if found then
    return v_ret;
  end if;

  select * into v_trip from trips where id = p_trip_id for update;
  if not found then
    raise exception 'TRIP_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_trip.driver_id <> auth.uid() then
    raise exception 'NOT_OWNER_OF_TRIP' using errcode = '42501';
  end if;

  -- total
  select coalesce(sum( (item->>'quantity')::numeric * (item->>'unit_price')::numeric ), 0)
    into v_total
    from jsonb_array_elements(p_items) as item;

  insert into returns(
    id, trip_id, sale_id, customer_id, driver_id, status,
    total_amount, reason, client_created_at, synced_at
  ) values (
    p_return_id, p_trip_id, p_sale_id, p_customer_id, auth.uid(), 'pending',
    v_total, p_reason, p_client_created_at, now()
  ) returning * into v_ret;

  insert into return_items(id, return_id, product_id, quantity, unit_price, line_total)
  select
    gen_random_uuid(),
    p_return_id,
    (item->>'product_id')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    ((item->>'quantity')::numeric * (item->>'unit_price')::numeric)
  from jsonb_array_elements(p_items) as item;

  -- return_in movement → vehicle gains stock back
  insert into inventory_movements(id, kind, product_id, quantity, vehicle_id,
                                  reference_id, reference_type, performed_by)
  select
    gen_random_uuid(),
    'return_in',
    (item->>'product_id')::uuid,
    (item->>'quantity')::numeric,
    v_trip.vehicle_id,
    p_return_id,
    'return',
    auth.uid()
  from jsonb_array_elements(p_items) as item;

  return v_ret;
end $$;

-- ---------------------------------------------------------------------
-- close_trip (online-only)
-- Driver requests trip close → creates a cashier approval.
-- Manager approval flow handled separately via approve_production_run / etc.
-- ---------------------------------------------------------------------
create or replace function close_trip(
  p_trip_id      uuid,
  p_closing_cash numeric
) returns approvals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip     trips;
  v_approval approvals;
  v_app_id   uuid := gen_random_uuid();
begin
  select * into v_trip from trips where id = p_trip_id for update;
  if not found then
    raise exception 'TRIP_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_trip.driver_id <> auth.uid() then
    raise exception 'NOT_OWNER_OF_TRIP' using errcode = '42501';
  end if;
  if v_trip.status not in ('loaded','in_progress') then
    raise exception 'TRIP_ALREADY_CLOSED' using errcode = 'P0001';
  end if;

  update trips
    set closing_cash = p_closing_cash, updated_at = now()
    where id = p_trip_id;

  insert into approvals(
    id, kind, status, reference_id, reference_type,
    requested_by, amount, notes
  ) values (
    v_app_id, 'cashier', 'pending', p_trip_id, 'trip',
    auth.uid(), p_closing_cash, 'Trip close request'
  ) returning * into v_approval;

  return v_approval;
end $$;

-- ---------------------------------------------------------------------
-- approve_production_run — factory manager approves a production batch.
-- Emits production_in movement which credits factory inventory.
-- ---------------------------------------------------------------------
create or replace function approve_production_run(
  p_run_id     uuid,
  p_approval_id uuid
) returns production_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run production_runs;
begin
  if "current_role"() not in ('factory_manager','owner') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update production_runs
    set approval_id = p_approval_id
    where id = p_run_id and approval_id is null
    returning * into v_run;
  if not found then
    -- already linked; idempotent
    select * into v_run from production_runs where id = p_run_id;
    return v_run;
  end if;

  insert into inventory_movements(id, kind, product_id, quantity, factory_id,
                                  reference_id, reference_type, performed_by)
  values (
    gen_random_uuid(), 'production_in', v_run.product_id, v_run.quantity,
    v_run.factory_id, v_run.id, 'production_run', auth.uid()
  );

  update approvals set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_approval_id;

  return v_run;
end $$;

-- ---------------------------------------------------------------------
-- approve_cashier_reconciliation — cashier confirms cash received from driver.
-- Closes the trip on success.
-- ---------------------------------------------------------------------
create or replace function approve_cashier_reconciliation(
  p_recon_id uuid,
  p_approval_id uuid
) returns cashier_reconciliations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recon cashier_reconciliations;
begin
  if "current_role"() not in ('cashier','owner') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_recon from cashier_reconciliations where id = p_recon_id;
  if not found then
    raise exception 'RECON_NOT_FOUND' using errcode = 'P0002';
  end if;

  update approvals set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_approval_id;

  update trips set status = 'closed', closed_at = now() where id = v_recon.trip_id;

  return v_recon;
end $$;
