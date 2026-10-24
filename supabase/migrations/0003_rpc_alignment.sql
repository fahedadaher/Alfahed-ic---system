-- =====================================================================
-- Al-Fahad Ice — RPC alignment migration.
--
-- Adds:
--   - start_trip                 (loaded → in_progress, idempotent)
--   - decide_cashier_approval    (approve OR reject, with notes)
--   - decide_production_approval (approve OR reject, with notes)
--
-- The earlier production approval function only approved; managers now
-- need to be able to reject too. Rejection reverses any optimistic
-- state changes the request was based on.
-- =====================================================================

-- ---------------------------------------------------------------------
-- start_trip — flips loaded → in_progress. Idempotent.
-- ---------------------------------------------------------------------
create or replace function start_trip(
  p_trip_id    uuid,
  p_started_at timestamptz
) returns trips
language plpgsql
security definer
set search_path = public
as $$
declare v_trip trips;
begin
  select * into v_trip from trips where id = p_trip_id for update;
  if not found then
    raise exception 'TRIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_trip.driver_id <> auth.uid() and "current_role"() not in ('owner','factory_manager') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  -- Idempotent: if already started or beyond, return current state.
  if v_trip.status in ('in_progress','closed','cancelled') then
    return v_trip;
  end if;
  if v_trip.status <> 'loaded' then
    raise exception 'CONFLICT_TRIP_NOT_LOADED' using errcode = 'P0001';
  end if;

  update trips
    set status = 'in_progress',
        started_at = coalesce(started_at, p_started_at),
        updated_at = now()
    where id = p_trip_id
    returning * into v_trip;

  return v_trip;
end $$;

-- ---------------------------------------------------------------------
-- decide_cashier_approval — approve OR reject a cashier approval.
-- Replaces the approve-only flavor.
-- ---------------------------------------------------------------------
create or replace function decide_cashier_approval(
  p_approval_id uuid,
  p_decision    text,         -- 'approved' | 'rejected'
  p_notes       text
) returns approvals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app    approvals;
  v_recon  cashier_reconciliations;
begin
  if "current_role"() not in ('cashier','owner') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_decision not in ('approved','rejected') then
    raise exception 'BAD_DECISION' using errcode = '22023';
  end if;

  select * into v_app from approvals where id = p_approval_id for update;
  if not found then
    raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotent: already decided → return current.
  if v_app.status in ('approved','rejected') then
    return v_app;
  end if;
  if v_app.kind <> 'cashier' then
    raise exception 'CONFLICT_WRONG_KIND' using errcode = 'P0001';
  end if;

  update approvals
    set status      = p_decision::approval_status,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        notes       = coalesce(p_notes, notes),
        updated_at  = now()
    where id = p_approval_id
    returning * into v_app;

  -- Side-effect: on approval, close the trip linked to the recon.
  if p_decision = 'approved' and v_app.reference_type = 'cashier_reconciliation' then
    select * into v_recon from cashier_reconciliations where id = v_app.reference_id;
    if found then
      update trips set status = 'closed', closed_at = now(), updated_at = now()
        where id = v_recon.trip_id;
    end if;
  end if;

  return v_app;
end $$;

-- ---------------------------------------------------------------------
-- decide_production_approval — approve OR reject a production run.
-- ---------------------------------------------------------------------
create or replace function decide_production_approval(
  p_approval_id uuid,
  p_decision    text,
  p_notes       text
) returns approvals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app approvals;
  v_run production_runs;
begin
  if "current_role"() not in ('factory_manager','owner') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_decision not in ('approved','rejected') then
    raise exception 'BAD_DECISION' using errcode = '22023';
  end if;

  select * into v_app from approvals where id = p_approval_id for update;
  if not found then
    raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_app.status in ('approved','rejected') then
    return v_app;
  end if;
  if v_app.kind <> 'production' then
    raise exception 'CONFLICT_WRONG_KIND' using errcode = 'P0001';
  end if;

  update approvals
    set status      = p_decision::approval_status,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        notes       = coalesce(p_notes, notes),
        updated_at  = now()
    where id = p_approval_id
    returning * into v_app;

  -- On approval: post the production_in inventory movement (if not yet
  -- linked) and link the production run to the approval.
  if p_decision = 'approved' and v_app.reference_type = 'production_run' then
    select * into v_run from production_runs where id = v_app.reference_id for update;
    if found and v_run.approval_id is null then
      update production_runs set approval_id = v_app.id where id = v_run.id;

      insert into inventory_movements(
        id, kind, product_id, quantity, factory_id,
        reference_id, reference_type, performed_by
      ) values (
        gen_random_uuid(), 'production_in', v_run.product_id, v_run.quantity,
        v_run.factory_id, v_run.id, 'production_run', auth.uid()
      );
    end if;
  end if;

  return v_app;
end $$;
