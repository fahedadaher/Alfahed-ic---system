-- =====================================================================
-- Al-Fahad Ice — vehicle_load RPC.
--
-- `vehicle-loads.service.ts` has always enqueued 'rpc:vehicle_load', but
-- no such function existed: every load sat in the outbox failing, and
-- (before the drain fix) blocked every op queued behind it.
--
-- Idempotent on vehicle_loads' unique (trip_id, product_id): replaying
-- the same op inserts nothing and posts no second movement, so the
-- outbox can safely retry after a timeout that actually committed.
-- =====================================================================

create or replace function vehicle_load(
  p_trip_id    uuid,
  p_vehicle_id uuid,
  p_factory_id uuid,
  p_lines      jsonb          -- [{product_id, quantity}]
) returns setof vehicle_loads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip      trips;
  v_line      jsonb;
  v_product   uuid;
  v_quantity  numeric(14,3);
  v_available numeric(14,3);
  v_load_id   uuid;
begin
  if current_role() not in ('factory_manager','owner') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'NO_LINES' using errcode = '22023';
  end if;

  select * into v_trip from trips where id = p_trip_id for update;
  if not found then
    raise exception 'TRIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_trip.vehicle_id <> p_vehicle_id then
    raise exception 'CONFLICT_VEHICLE_MISMATCH' using errcode = 'P0001';
  end if;

  -- Loading is only meaningful before the driver takes the trip out.
  if v_trip.status not in ('planned','loaded') then
    raise exception 'CONFLICT_TRIP_NOT_LOADABLE' using errcode = 'P0001';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product  := (v_line->>'product_id')::uuid;
    v_quantity := (v_line->>'quantity')::numeric;

    if v_product is null then
      raise exception 'BAD_PRODUCT' using errcode = '22023';
    end if;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'BAD_QUANTITY' using errcode = '22023';
    end if;

    -- Lock the factory balance so two concurrent loads cannot both pass
    -- the stock check and drive the balance negative.
    select quantity into v_available
      from inventory_balances
      where factory_id = p_factory_id and product_id = v_product
      for update;

    -- Idempotency gate: only charge stock for a line we actually insert.
    insert into vehicle_loads(id, trip_id, product_id, quantity, loaded_by)
      values (gen_random_uuid(), p_trip_id, v_product, v_quantity, auth.uid())
      on conflict (trip_id, product_id) do nothing
      returning id into v_load_id;

    if v_load_id is not null then
      if coalesce(v_available, 0) < v_quantity then
        raise exception 'CONFLICT_INSUFFICIENT_STOCK' using errcode = 'P0001';
      end if;

      -- trg_apply_movement moves the balances: factory -qty, vehicle +qty.
      insert into inventory_movements(
        id, kind, product_id, quantity, factory_id, vehicle_id,
        reference_id, reference_type, performed_by
      ) values (
        gen_random_uuid(), 'vehicle_load', v_product, v_quantity,
        p_factory_id, p_vehicle_id, p_trip_id, 'trip', auth.uid()
      );
    end if;

    v_load_id := null;
  end loop;

  update trips
    set status = 'loaded', updated_at = now()
    where id = p_trip_id and status = 'planned';

  return query select * from vehicle_loads where trip_id = p_trip_id;
end $$;
