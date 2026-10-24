-- =====================================================================
-- Al-Fahad — Amp subscriptions ⇄ smart meters.
--
-- Ground rule: the value configured ON THE METER is the only confirmed
-- truth. Nothing in this schema can mark an amp change as done unless a
-- reading taken from the meter itself shows it.
--
--   amp_subscriptions.registered_amps   the value the system bills on;
--                                       changes ONLY when a meter
--                                       reading is ingested
--   smart_meters.confirmed_amps         last value read from the meter
--                                       (kept as-is while offline)
--   meter_commands                      requests to change the meter;
--                                       'confirmed' only when a reading
--                                       matches the requested value
--   amp_change_log                      append-only: previous → new,
--                                       when, source, actor
--   amp_billing_adjustments             price difference per policy +
--                                       effective date; issued invoices
--                                       are never touched
--   meter_alerts                        de-duplicated alerts for
--                                       management
--
-- Writers:
--   - The `meter-gateway` edge function (service_role) talks to meters
--     and calls the meter_* RPCs.
--   - Managers call request_amp_change / link_meter / … (online-only).
--   - Guard triggers reject direct writes to meter-owned columns.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type meter_connection_status as enum ('unknown','online','offline');
create type amp_subscription_status as enum ('active','suspended','closed');
create type amp_change_source       as enum ('meter_push','meter_poll','reconnect_sync','system_command');
create type meter_reading_source    as enum ('push','poll','command_verify');
create type meter_command_status    as enum ('pending','sent','confirmed','failed','expired','cancelled');
create type meter_alert_kind        as enum (
  'discrepancy',            -- system amps ≠ meter amps
  'limit_violation',        -- meter set above the allowed technical limit
  'meter_offline',
  'unlinked_subscription',
  'sync_failed',            -- a read from the meter failed / was implausible
  'command_failed'          -- a command failed or expired unconfirmed
);
create type meter_alert_status      as enum ('open','resolved');
create type amp_adjustment_status   as enum ('pending','needs_pricing','applied','void');
create type amp_invoice_status      as enum ('draft','issued','void');

-- ---------------------------------------------------------------------
-- Settings (singleton row, id = 1)
-- ---------------------------------------------------------------------
create table meter_settings (
  id                              int primary key default 1 check (id = 1),
  poll_interval_seconds           int  not null default 300  check (poll_interval_seconds >= 30),
  push_heartbeat_seconds          int  not null default 3600 check (push_heartbeat_seconds >= 60),
  offline_after_seconds           int  not null default 900  check (offline_after_seconds >= 60),
  failures_before_offline         int  not null default 3    check (failures_before_offline >= 1),
  command_confirm_timeout_seconds int  not null default 120  check (command_confirm_timeout_seconds >= 10),
  command_ttl_seconds             int  not null default 3600 check (command_ttl_seconds >= 60),
  command_max_attempts            int  not null default 3    check (command_max_attempts >= 1),
  billing_timezone                text not null default 'Asia/Baghdad',
  updated_at                      timestamptz not null default now()
);
insert into meter_settings (id) values (1);

-- ---------------------------------------------------------------------
-- Meters
-- ---------------------------------------------------------------------
create table smart_meters (
  id                      uuid primary key default gen_random_uuid(),
  serial_no               text not null unique,
  model                   text,
  driver                  text not null default 'http_headend',   -- gateway adapter key
  supports_push           boolean not null default false,
  supports_remote_control boolean not null default false,
  min_amps                numeric(7,2) not null default 1   check (min_amps >= 0),
  max_amps                numeric(7,2) not null              check (max_amps > 0),  -- hardware limit
  step_amps               numeric(7,2) not null default 1   check (step_amps > 0),
  poll_interval_seconds   int check (poll_interval_seconds is null or poll_interval_seconds >= 30),
  factory_id              uuid references factories(id),
  active                  boolean not null default true,

  -- meter-owned state (written only by the gateway RPCs)
  confirmed_amps          numeric(7,2),
  confirmed_at            timestamptz,
  last_seen_at            timestamptz,
  last_sync_at            timestamptz,
  connection_status       meter_connection_status not null default 'unknown',
  consecutive_failures    int not null default 0,
  last_error              text,
  next_poll_at            timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check (min_amps <= max_amps)
);
create index smart_meters_poll_idx on smart_meters(next_poll_at) where active;

-- ---------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------
create table amp_subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  subscription_no      text not null unique,
  customer_id          uuid references customers(id),
  subscriber_name      text not null,
  phone                text,
  address              text,
  factory_id           uuid references factories(id),
  status               amp_subscription_status not null default 'active',
  -- What the installation (cable / breaker) can carry. Commands can
  -- never exceed min(this, meter.max_amps).
  max_connection_amps  numeric(7,2) check (max_connection_amps is null or max_connection_amps > 0),
  registered_amps      numeric(7,2) not null check (registered_amps >= 0),
  meter_id             uuid unique references smart_meters(id),
  meter_linked_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Raw readings (append-only). Every value read from a meter lands here,
-- accepted or not. `id` is generated by the gateway → idempotent.
-- ---------------------------------------------------------------------
create table meter_readings (
  id                 uuid primary key,
  meter_id           uuid not null references smart_meters(id),
  amps               numeric,                       -- raw, unconstrained: implausible values are kept too
  meter_time         timestamptz,                  -- device clock, if reported
  read_at            timestamptz not null default now(),
  source             meter_reading_source not null,
  external_event_id  text,                          -- push event id from the head-end
  accepted           boolean not null,
  reject_reason      text,
  result             jsonb not null default '{}'::jsonb
);
create index meter_readings_meter_idx on meter_readings(meter_id, read_at desc);
create unique index meter_readings_event_uniq
  on meter_readings(meter_id, external_event_id) where external_event_id is not null;

-- ---------------------------------------------------------------------
-- Commands to the meter. `id` is client-generated (idempotency key) and
-- is also passed to the head-end as its request id.
-- ---------------------------------------------------------------------
create table meter_commands (
  id                    uuid primary key,
  subscription_id       uuid not null references amp_subscriptions(id),
  meter_id              uuid not null references smart_meters(id),
  previous_amps         numeric(7,2),             -- meter value when requested
  requested_amps        numeric(7,2) not null,
  status                meter_command_status not null default 'pending',
  attempts              int not null default 0,   -- number of sends to the meter
  last_error            text,
  note                  text,
  requested_by          uuid not null references profiles(id),
  requested_at          timestamptz not null default now(),
  sent_at               timestamptz,              -- first send
  last_sent_at          timestamptz,
  lease_until           timestamptz,              -- gateway worker lease
  next_attempt_at       timestamptz not null default now(),
  expires_at            timestamptz not null,
  confirmed_at          timestamptz,
  confirmed_reading_id  uuid references meter_readings(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- at most one in-flight command per meter
create unique index meter_commands_one_active
  on meter_commands(meter_id) where status in ('pending','sent');
create index meter_commands_due_idx on meter_commands(next_attempt_at) where status in ('pending','sent');

-- ---------------------------------------------------------------------
-- Change log (append-only). One row per accepted change in meter value.
-- ---------------------------------------------------------------------
create table amp_change_log (
  id               uuid primary key default gen_random_uuid(),
  subscription_id  uuid not null references amp_subscriptions(id),
  meter_id         uuid not null references smart_meters(id),
  previous_amps    numeric(7,2) not null,
  new_amps         numeric(7,2) not null,
  changed_at       timestamptz not null,           -- when the meter showed it
  recorded_at      timestamptz not null default now(),
  source           amp_change_source not null,
  actor_id         uuid references profiles(id),   -- requester, for system_command
  command_id       uuid references meter_commands(id),
  reading_id       uuid not null unique references meter_readings(id)
);
create index amp_change_log_sub_idx on amp_change_log(subscription_id, changed_at desc);
create index amp_change_log_time_idx on amp_change_log(changed_at desc);

-- ---------------------------------------------------------------------
-- Pricing & billing
-- ---------------------------------------------------------------------
create table amp_price_policies (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  price_per_amp      numeric(12,3) not null check (price_per_amp >= 0),   -- per billing cycle
  currency           text not null default 'IQD',
  effective_from     date not null,
  -- 'daily'      : the difference is prorated by day from the change date
  -- 'next_cycle' : the new amps are billed from the next cycle; no
  --                difference for the current one
  proration          text not null default 'daily' check (proration in ('daily','next_cycle')),
  billing_cycle_day  int  not null default 1 check (billing_cycle_day between 1 and 28),
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create index amp_price_policies_eff_idx on amp_price_policies(effective_from desc) where active;

create table amp_invoices (
  id               uuid primary key default gen_random_uuid(),
  subscription_id  uuid not null references amp_subscriptions(id),
  period_start     date not null,
  period_end       date not null,          -- exclusive
  amps             numeric(7,2) not null,
  amount           numeric(14,2) not null,
  status           amp_invoice_status not null default 'draft',
  issued_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (period_end > period_start)
);
create unique index amp_invoices_period_uniq
  on amp_invoices(subscription_id, period_start) where status <> 'void';

create table amp_billing_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  change_id           uuid not null unique references amp_change_log(id),
  subscription_id     uuid not null references amp_subscriptions(id),
  price_policy_id     uuid references amp_price_policies(id),
  previous_amps       numeric(7,2) not null,
  new_amps            numeric(7,2) not null,
  effective_from      date not null,
  period_start        date,
  period_end          date,
  days_charged        int,
  days_in_period      int,
  amount              numeric(14,2),       -- + charge / − credit; null while needs_pricing
  status              amp_adjustment_status not null,
  applied_invoice_id  uuid references amp_invoices(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index amp_billing_adj_sub_idx on amp_billing_adjustments(subscription_id, effective_from);

-- ---------------------------------------------------------------------
-- Alerts. One open alert per (kind, meter, subscription); repeats bump
-- `occurrences` instead of creating noise.
-- ---------------------------------------------------------------------
create table meter_alerts (
  id               uuid primary key default gen_random_uuid(),
  kind             meter_alert_kind not null,
  status           meter_alert_status not null default 'open',
  subscription_id  uuid references amp_subscriptions(id),
  meter_id         uuid references smart_meters(id),
  subject_key      text generated always as (
                     coalesce(meter_id::text, '-') || ':' || coalesce(subscription_id::text, '-')
                   ) stored,
  message          text not null,
  details          jsonb not null default '{}'::jsonb,
  occurrences      int not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references profiles(id),
  resolution_note  text,
  updated_at       timestamptz not null default now()
);
create unique index meter_alerts_open_uniq on meter_alerts(kind, subject_key) where status = 'open';
create index meter_alerts_status_idx on meter_alerts(status, last_seen_at desc);

-- ---------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------
create trigger trg_smart_meters_updated   before update on smart_meters            for each row execute function tg_set_updated_at();
create trigger trg_amp_subs_updated       before update on amp_subscriptions       for each row execute function tg_set_updated_at();
create trigger trg_meter_commands_updated before update on meter_commands          for each row execute function tg_set_updated_at();
create trigger trg_amp_invoices_updated   before update on amp_invoices            for each row execute function tg_set_updated_at();
create trigger trg_amp_adj_updated        before update on amp_billing_adjustments for each row execute function tg_set_updated_at();
create trigger trg_meter_alerts_updated   before update on meter_alerts            for each row execute function tg_set_updated_at();
create trigger trg_meter_settings_updated before update on meter_settings          for each row execute function tg_set_updated_at();

-- =====================================================================
-- Guards
-- =====================================================================

-- Internal writers flip this transaction-local flag; the guards below
-- reject changes to meter-owned columns from anyone else.
create or replace function amp_internal_on()  returns void language sql as $$ select set_config('app.amp_internal', 'on',  true) $$;
create or replace function amp_internal_off() returns void language sql as $$ select set_config('app.amp_internal', 'off', true) $$;
create or replace function amp_is_internal()  returns boolean language sql stable as $$
  select coalesce(current_setting('app.amp_internal', true), '') = 'on'
$$;

create or replace function tg_guard_amp_subscription() returns trigger language plpgsql as $$
begin
  if amp_is_internal() then return new; end if;
  if tg_op = 'INSERT' then
    if new.meter_id is not null then
      raise exception 'USE_LINK_METER: link meters with link_meter()' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.registered_amps is distinct from old.registered_amps then
    raise exception 'AMPS_FROM_METER_ONLY: registered amps change only from a confirmed meter reading'
      using errcode = '42501';
  end if;
  if new.meter_id is distinct from old.meter_id or new.meter_linked_at is distinct from old.meter_linked_at then
    raise exception 'USE_LINK_METER: link meters with link_meter()' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_amp_subscription
  before insert or update on amp_subscriptions
  for each row execute function tg_guard_amp_subscription();

create or replace function tg_guard_smart_meter() returns trigger language plpgsql as $$
begin
  if amp_is_internal() then return new; end if;
  if tg_op = 'INSERT' then
    new.confirmed_amps := null; new.confirmed_at := null;
    new.last_seen_at := null;   new.last_sync_at := null;
    new.connection_status := 'unknown';
    new.consecutive_failures := 0; new.last_error := null;
    new.next_poll_at := now();
    return new;
  end if;
  if (new.confirmed_amps, new.confirmed_at, new.last_seen_at, new.last_sync_at,
      new.connection_status, new.consecutive_failures, new.last_error)
     is distinct from
     (old.confirmed_amps, old.confirmed_at, old.last_seen_at, old.last_sync_at,
      old.connection_status, old.consecutive_failures, old.last_error) then
    raise exception 'METER_STATE_FROM_GATEWAY_ONLY' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_smart_meter
  before insert or update on smart_meters
  for each row execute function tg_guard_smart_meter();

create or replace function tg_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'APPEND_ONLY: % rows cannot be changed', tg_table_name using errcode = '42501';
end $$;
create trigger trg_amp_change_log_append_only
  before update or delete on amp_change_log
  for each row execute function tg_append_only();

-- Issued invoices are frozen; only issued → void is allowed.
create or replace function tg_guard_amp_invoice() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'INVOICE_LOCKED' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status = 'void' then
    raise exception 'INVOICE_LOCKED' using errcode = '42501';
  end if;
  if old.status = 'issued' and (
       (new.subscription_id, new.period_start, new.period_end, new.amps, new.amount, new.issued_at)
       is distinct from
       (old.subscription_id, old.period_start, old.period_end, old.amps, old.amount, old.issued_at)
       or new.status = 'draft') then
    raise exception 'INVOICE_LOCKED' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_amp_invoice
  before update or delete on amp_invoices
  for each row execute function tg_guard_amp_invoice();

-- =====================================================================
-- Internal helpers (not exposed to clients)
-- =====================================================================

create or replace function amp_raise_alert(
  p_kind meter_alert_kind, p_subscription_id uuid, p_meter_id uuid,
  p_message text, p_details jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into meter_alerts(kind, subscription_id, meter_id, message, details)
  values (p_kind, p_subscription_id, p_meter_id, p_message, coalesce(p_details, '{}'::jsonb))
  on conflict (kind, subject_key) where status = 'open' do update
    set occurrences  = meter_alerts.occurrences + 1,
        last_seen_at = now(),
        message      = excluded.message,
        details      = excluded.details
  returning id into v_id;
  return v_id;
end $$;

create or replace function amp_resolve_alerts(
  p_kind meter_alert_kind, p_subscription_id uuid, p_meter_id uuid, p_note text
) returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update meter_alerts
     set status = 'resolved', resolved_at = now(), resolution_note = p_note
   where status = 'open' and kind = p_kind
     and subscription_id is not distinct from p_subscription_id
     and meter_id is not distinct from p_meter_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Billing period [start, end) containing p_date for a monthly cycle.
create or replace function amp_billing_period(p_date date, p_cycle_day int,
  out period_start date, out period_end date)
language plpgsql immutable as $$
begin
  period_start := make_date(extract(year from p_date)::int, extract(month from p_date)::int, p_cycle_day);
  if period_start > p_date then
    period_start := (period_start - interval '1 month')::date;
  end if;
  period_end := (period_start + interval '1 month')::date;
end $$;

-- Price difference for one change. Never touches invoices: the row is
-- picked up by the next invoice as a separate line.
create or replace function amp_create_adjustment(p_change_id uuid)
returns amp_billing_adjustments
language plpgsql security definer set search_path = public as $$
declare
  v_chg   amp_change_log;
  v_pol   amp_price_policies;
  v_tz    text;
  v_date  date;
  v_ps    date;
  v_pe    date;
  v_eff   date;
  v_days  int;
  v_total int;
  v_amt   numeric(14,2);
  v_row   amp_billing_adjustments;
begin
  select * into v_row from amp_billing_adjustments where change_id = p_change_id;
  if found then return v_row; end if;

  select * into v_chg from amp_change_log where id = p_change_id;
  select billing_timezone into v_tz from meter_settings where id = 1;
  v_date := (v_chg.changed_at at time zone v_tz)::date;

  select * into v_pol from amp_price_policies
   where active and effective_from <= v_date
   order by effective_from desc, created_at desc limit 1;

  if not found then
    insert into amp_billing_adjustments(change_id, subscription_id, previous_amps, new_amps,
                                        effective_from, status)
    values (v_chg.id, v_chg.subscription_id, v_chg.previous_amps, v_chg.new_amps, v_date, 'needs_pricing')
    returning * into v_row;
    return v_row;
  end if;

  select b.period_start, b.period_end into v_ps, v_pe
    from amp_billing_period(v_date, v_pol.billing_cycle_day) b;
  v_total := v_pe - v_ps;

  if v_pol.proration = 'daily' then
    v_eff  := v_date;
    v_days := v_pe - v_date;
    v_amt  := round((v_chg.new_amps - v_chg.previous_amps) * v_pol.price_per_amp * v_days / v_total, 2);
  else
    v_eff  := v_pe;
    v_days := 0;
    v_amt  := 0;
  end if;

  insert into amp_billing_adjustments(change_id, subscription_id, price_policy_id,
    previous_amps, new_amps, effective_from, period_start, period_end,
    days_charged, days_in_period, amount, status)
  values (v_chg.id, v_chg.subscription_id, v_pol.id,
    v_chg.previous_amps, v_chg.new_amps, v_eff, v_ps, v_pe,
    v_days, v_total, v_amt, 'pending')
  returning * into v_row;
  return v_row;
end $$;

-- =====================================================================
-- Gateway RPCs (service_role only — see grants at the bottom)
-- =====================================================================

-- ---------------------------------------------------------------------
-- meter_ingest_reading — record a value READ FROM THE METER and
-- reconcile the subscription. Idempotent on p_reading_id and on
-- (meter, p_external_event_id).
-- ---------------------------------------------------------------------
create or replace function meter_ingest_reading(
  p_reading_id        uuid,
  p_serial_no         text,
  p_amps              numeric,
  p_meter_time        timestamptz,
  p_source            meter_reading_source,
  p_external_event_id text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_meter     smart_meters;
  v_sub       amp_subscriptions;
  v_cmd       meter_commands;
  v_existing  meter_readings;
  v_settings  meter_settings;
  -- device clock, never ahead of the server (a fast meter clock must
  -- not make later readings look stale)
  v_at        timestamptz := least(coalesce(p_meter_time, now()), now());
  v_was_off   boolean;
  v_limit     numeric;
  v_source    amp_change_source;
  v_change_id uuid;
  v_result    jsonb;
  v_cmd_state text := null;
begin
  select * into v_existing from meter_readings where id = p_reading_id;
  if found then return v_existing.result || jsonb_build_object('replay', true); end if;

  select * into v_meter from smart_meters where serial_no = p_serial_no for update;
  if not found then
    raise exception 'METER_NOT_FOUND:%', p_serial_no using errcode = 'P0002';
  end if;

  if p_external_event_id is not null then
    select * into v_existing from meter_readings
     where meter_id = v_meter.id and external_event_id = p_external_event_id;
    if found then return v_existing.result || jsonb_build_object('replay', true); end if;
  end if;

  select * into v_settings from meter_settings where id = 1;
  perform amp_internal_on();

  -- The meter answered → it is online.
  v_was_off := v_meter.connection_status = 'offline';
  update smart_meters
     set last_seen_at = now(), connection_status = 'online',
         consecutive_failures = 0, last_error = null
   where id = v_meter.id;
  if v_was_off then
    perform amp_resolve_alerts('meter_offline', null, v_meter.id, 'meter reconnected');
  end if;

  -- Implausible value: outside what the hardware can be set to.
  if p_amps is null or p_amps < 0 or p_amps > v_meter.max_amps then
    v_result := jsonb_build_object('status', 'rejected', 'reason', 'IMPLAUSIBLE_VALUE');
    insert into meter_readings(id, meter_id, amps, meter_time, source, external_event_id, accepted, reject_reason, result)
    values (p_reading_id, v_meter.id, p_amps, p_meter_time, p_source, p_external_event_id,
            false, 'IMPLAUSIBLE_VALUE', v_result);
    perform amp_raise_alert('sync_failed', null, v_meter.id,
      format('Implausible value %s A read from meter %s', p_amps, v_meter.serial_no),
      jsonb_build_object('amps', p_amps, 'max_amps', v_meter.max_amps));
    perform amp_internal_off();
    return v_result;
  end if;

  -- Out-of-order: older than what we already confirmed.
  if p_meter_time is not null and v_meter.confirmed_at is not null and v_at < v_meter.confirmed_at then
    v_result := jsonb_build_object('status', 'rejected', 'reason', 'STALE_READING');
    insert into meter_readings(id, meter_id, amps, meter_time, source, external_event_id, accepted, reject_reason, result)
    values (p_reading_id, v_meter.id, p_amps, p_meter_time, p_source, p_external_event_id,
            false, 'STALE_READING', v_result);
    perform amp_internal_off();
    return v_result;
  end if;

  insert into meter_readings(id, meter_id, amps, meter_time, source, external_event_id, accepted)
  values (p_reading_id, v_meter.id, p_amps, p_meter_time, p_source, p_external_event_id, true);

  update smart_meters
     set confirmed_amps = p_amps, confirmed_at = v_at, last_sync_at = now(),
         next_poll_at = now() + make_interval(secs =>
           case when supports_push then v_settings.push_heartbeat_seconds
                else coalesce(poll_interval_seconds, v_settings.poll_interval_seconds) end)
   where id = v_meter.id;
  perform amp_resolve_alerts('sync_failed', null, v_meter.id, 'meter read OK');

  select * into v_sub from amp_subscriptions where meter_id = v_meter.id for update;

  -- In-flight command for this meter?
  select * into v_cmd from meter_commands
   where meter_id = v_meter.id and status in ('pending','sent') for update;
  if found then
    if p_amps = v_cmd.requested_amps then
      update meter_commands
         set status = 'confirmed', confirmed_at = now(), confirmed_reading_id = p_reading_id,
             last_error = null, lease_until = null
       where id = v_cmd.id;
      v_cmd_state := 'confirmed';
      perform amp_resolve_alerts('command_failed', v_cmd.subscription_id, v_meter.id, 'command confirmed');
    elsif p_amps is distinct from v_cmd.previous_amps then
      -- The meter moved to a third value: someone changed it locally.
      -- Never send (or re-send) over a local change.
      update meter_commands
         set status = 'failed', last_error = 'SUPERSEDED_BY_METER_CHANGE', lease_until = null
       where id = v_cmd.id;
      v_cmd_state := 'superseded';
      perform amp_raise_alert('command_failed', v_cmd.subscription_id, v_meter.id,
        format('Command to set %s A superseded: meter now reports %s A', v_cmd.requested_amps, p_amps),
        jsonb_build_object('command_id', v_cmd.id));
    end if;
  end if;

  if v_sub.id is null then
    v_result := jsonb_build_object('status', 'accepted', 'changed', false, 'linked', false,
                                   'command', v_cmd_state);
  elsif p_amps = v_sub.registered_amps then
    perform amp_resolve_alerts('discrepancy',     v_sub.id, v_meter.id, 'values match');
    perform amp_resolve_alerts('limit_violation', v_sub.id, v_meter.id, 'values match');
    v_result := jsonb_build_object('status', 'accepted', 'changed', false, 'linked', true,
                                   'command', v_cmd_state);
  else
    v_limit := least(v_meter.max_amps, coalesce(v_sub.max_connection_amps, v_meter.max_amps));
    if p_amps > v_limit then
      -- The meter really is at p_amps (confirmed_amps shows it), but the
      -- system will not adopt a value above the technical limit.
      perform amp_raise_alert('limit_violation', v_sub.id, v_meter.id,
        format('Meter %s is set to %s A, above the allowed %s A for subscription %s',
               v_meter.serial_no, p_amps, v_limit, v_sub.subscription_no),
        jsonb_build_object('meter_amps', p_amps, 'limit', v_limit, 'registered_amps', v_sub.registered_amps));
      v_result := jsonb_build_object('status', 'accepted', 'changed', false, 'linked', true,
                                     'reason', 'ABOVE_TECHNICAL_LIMIT', 'command', v_cmd_state);
    else
      v_source := case
        when v_cmd_state = 'confirmed' then 'system_command'
        when v_was_off                 then 'reconnect_sync'
        when p_source = 'push'         then 'meter_push'
        else 'meter_poll' end::amp_change_source;

      insert into amp_change_log(subscription_id, meter_id, previous_amps, new_amps, changed_at,
                                 source, actor_id, command_id, reading_id)
      values (v_sub.id, v_meter.id, v_sub.registered_amps, p_amps, v_at, v_source,
              case when v_cmd_state = 'confirmed' then v_cmd.requested_by end,
              case when v_cmd_state = 'confirmed' then v_cmd.id end,
              p_reading_id)
      returning id into v_change_id;

      update amp_subscriptions set registered_amps = p_amps where id = v_sub.id;
      perform amp_create_adjustment(v_change_id);
      perform amp_resolve_alerts('discrepancy',     v_sub.id, v_meter.id, 'synced from meter');
      perform amp_resolve_alerts('limit_violation', v_sub.id, v_meter.id, 'synced from meter');

      v_result := jsonb_build_object('status', 'accepted', 'changed', true, 'linked', true,
                                     'change_id', v_change_id, 'previous_amps', v_sub.registered_amps,
                                     'new_amps', p_amps, 'source', v_source, 'command', v_cmd_state);
    end if;
  end if;

  update meter_readings set result = v_result where id = p_reading_id;
  perform amp_internal_off();
  return v_result;
end $$;

-- meter_readings is append-only, but the ingest function stores its
-- own result on the row it just inserted. Allow exactly that.
create or replace function tg_meter_readings_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and amp_is_internal()
     and (new.id, new.meter_id, new.amps, new.meter_time, new.read_at, new.source,
          new.external_event_id, new.accepted, new.reject_reason)
         is not distinct from
         (old.id, old.meter_id, old.amps, old.meter_time, old.read_at, old.source,
          old.external_event_id, old.accepted, old.reject_reason) then
    return new;
  end if;
  raise exception 'APPEND_ONLY: % rows cannot be changed', tg_table_name using errcode = '42501';
end $$;
create trigger trg_meter_readings_append_only
  before update or delete on meter_readings
  for each row execute function tg_meter_readings_guard();

-- ---------------------------------------------------------------------
-- meter_record_failure — a read/command call could not reach the meter.
-- The last confirmed value is kept untouched.
-- ---------------------------------------------------------------------
create or replace function meter_record_failure(p_serial_no text, p_error text)
returns smart_meters
language plpgsql security definer set search_path = public as $$
declare
  v_meter    smart_meters;
  v_settings meter_settings;
  v_backoff  int;
begin
  select * into v_settings from meter_settings where id = 1;
  select * into v_meter from smart_meters where serial_no = p_serial_no for update;
  if not found then
    raise exception 'METER_NOT_FOUND:%', p_serial_no using errcode = 'P0002';
  end if;

  perform amp_internal_on();
  -- back off polling: 1, 2, 4 … × interval, capped at 8×
  v_backoff := coalesce(v_meter.poll_interval_seconds, v_settings.poll_interval_seconds)
               * power(2, least(v_meter.consecutive_failures, 3))::int;
  update smart_meters
     set consecutive_failures = consecutive_failures + 1,
         last_error = left(p_error, 500),
         connection_status = case when consecutive_failures + 1 >= v_settings.failures_before_offline
                                  then 'offline'::meter_connection_status else connection_status end,
         next_poll_at = now() + make_interval(secs => v_backoff)
   where id = v_meter.id
   returning * into v_meter;

  perform amp_raise_alert('sync_failed', null, v_meter.id,
    format('Could not read meter %s: %s', v_meter.serial_no, left(p_error, 200)),
    jsonb_build_object('consecutive_failures', v_meter.consecutive_failures));
  if v_meter.connection_status = 'offline' then
    perform amp_raise_alert('meter_offline', null, v_meter.id,
      format('Meter %s is offline; last confirmed value %s A at %s',
             v_meter.serial_no, coalesce(v_meter.confirmed_amps::text, '—'),
             coalesce(v_meter.confirmed_at::text, 'never')),
      jsonb_build_object('confirmed_amps', v_meter.confirmed_amps, 'confirmed_at', v_meter.confirmed_at));
  end if;
  perform amp_internal_off();
  return v_meter;
end $$;

-- ---------------------------------------------------------------------
-- meter_claim_poll_batch — meters due for a read. Pushes next_poll_at
-- forward as a lease so concurrent workers don't double-read.
-- ---------------------------------------------------------------------
create or replace function meter_claim_poll_batch(p_limit int default 50)
returns setof smart_meters
language plpgsql security definer set search_path = public as $$
begin
  perform amp_internal_on();
  return query
  with due as (
    select id from smart_meters
     where active and (next_poll_at is null or next_poll_at <= now())
     order by next_poll_at nulls first
     limit p_limit
     for update skip locked
  )
  update smart_meters m set next_poll_at = now() + interval '2 minutes'
    from due where m.id = due.id
  returning m.*;
  perform amp_internal_off();
end $$;

-- ---------------------------------------------------------------------
-- meter_expire_commands — pending/sent past their TTL become 'expired'.
-- A late meter change is still picked up truthfully by the next read.
-- ---------------------------------------------------------------------
create or replace function meter_expire_commands() returns int
language plpgsql security definer set search_path = public as $$
declare v_cmd meter_commands; v_n int := 0;
begin
  for v_cmd in
    update meter_commands set status = 'expired', last_error = coalesce(last_error, 'EXPIRED'), lease_until = null
     where status in ('pending','sent') and expires_at <= now()
    returning *
  loop
    v_n := v_n + 1;
    perform amp_raise_alert('command_failed', v_cmd.subscription_id, v_cmd.meter_id,
      format('Command to set %s A expired without meter confirmation', v_cmd.requested_amps),
      jsonb_build_object('command_id', v_cmd.id, 'last_error', v_cmd.last_error));
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- meter_claim_commands — commands due for work, leased to one worker.
-- ---------------------------------------------------------------------
create or replace function meter_claim_commands(p_limit int default 20)
returns table (
  command_id uuid, meter_id uuid, serial_no text, driver text,
  requested_amps numeric, status meter_command_status, attempts int,
  last_sent_at timestamptz, confirm_timeout_seconds int, max_attempts int
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_settings meter_settings;
begin
  perform meter_expire_commands();
  select * into v_settings from meter_settings where id = 1;
  return query
  with due as (
    select c.id from meter_commands c
     where c.status in ('pending','sent')
       and c.next_attempt_at <= now()
       and (c.lease_until is null or c.lease_until <= now())
     order by c.requested_at
     limit p_limit
     for update skip locked
  )
  update meter_commands c
     set lease_until = now() + make_interval(secs => v_settings.command_confirm_timeout_seconds)
    from due, smart_meters m
   where c.id = due.id and m.id = c.meter_id
  returning c.id, c.meter_id, m.serial_no, m.driver, c.requested_amps, c.status, c.attempts,
            c.last_sent_at, v_settings.command_confirm_timeout_seconds, v_settings.command_max_attempts;
end $$;

-- ---------------------------------------------------------------------
-- meter_command_sent — the head-end accepted the set-limit call. This is
-- NOT confirmation; only a matching reading confirms.
-- ---------------------------------------------------------------------
create or replace function meter_command_sent(p_command_id uuid) returns meter_commands
language plpgsql security definer set search_path = public as $$
declare v_cmd meter_commands;
begin
  update meter_commands
     set status = 'sent', attempts = attempts + 1,
         sent_at = coalesce(sent_at, now()), last_sent_at = now()
   where id = p_command_id and status in ('pending','sent')
  returning * into v_cmd;
  if not found then
    select * into v_cmd from meter_commands where id = p_command_id;
  end if;
  return v_cmd;
end $$;

-- ---------------------------------------------------------------------
-- meter_command_unconfirmed — a send failed, or the meter does not yet
-- show the requested value. Retries with backoff until max attempts;
-- p_permanent (e.g. meter refused the value) fails immediately.
-- ---------------------------------------------------------------------
create or replace function meter_command_unconfirmed(
  p_command_id uuid, p_error text, p_permanent boolean default false
) returns meter_commands
language plpgsql security definer set search_path = public as $$
declare v_cmd meter_commands; v_settings meter_settings;
begin
  select * into v_settings from meter_settings where id = 1;
  select * into v_cmd from meter_commands where id = p_command_id for update;
  if not found or v_cmd.status not in ('pending','sent') then return v_cmd; end if;

  if p_permanent or v_cmd.attempts >= v_settings.command_max_attempts then
    update meter_commands set status = 'failed', last_error = left(p_error, 500), lease_until = null
     where id = p_command_id returning * into v_cmd;
    perform amp_raise_alert('command_failed', v_cmd.subscription_id, v_cmd.meter_id,
      format('Command to set %s A failed: %s', v_cmd.requested_amps, left(p_error, 200)),
      jsonb_build_object('command_id', v_cmd.id, 'attempts', v_cmd.attempts));
  else
    update meter_commands
       set last_error = left(p_error, 500), lease_until = null,
           next_attempt_at = now() + make_interval(secs => 15 * power(2, least(greatest(v_cmd.attempts, 0), 6))::int)
     where id = p_command_id returning * into v_cmd;
  end if;
  return v_cmd;
end $$;

-- =====================================================================
-- Management RPCs (authenticated; online-only on the client)
-- =====================================================================

create or replace function amp_require_manager() returns void language plpgsql stable
security definer set search_path = public as $$
begin
  if coalesce("current_role"()::text, '') not in ('owner','factory_manager') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- request_amp_change — queue a set-limit command. Idempotent on
-- p_command_id. Does NOT change registered_amps: that happens only when
-- the meter confirms.
-- ---------------------------------------------------------------------
create or replace function request_amp_change(
  p_command_id      uuid,
  p_subscription_id uuid,
  p_requested_amps  numeric,
  p_note            text default null
) returns meter_commands
language plpgsql security definer set search_path = public as $$
declare
  v_cmd      meter_commands;
  v_sub      amp_subscriptions;
  v_meter    smart_meters;
  v_settings meter_settings;
  v_limit    numeric;
begin
  perform amp_require_manager();

  select * into v_cmd from meter_commands where id = p_command_id;
  if found then
    if v_cmd.subscription_id <> p_subscription_id or v_cmd.requested_amps <> p_requested_amps then
      raise exception 'CONFLICT_COMMAND_ID_REUSED' using errcode = 'P0001';
    end if;
    return v_cmd;
  end if;

  select * into v_sub from amp_subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_sub.status <> 'active' then raise exception 'SUBSCRIPTION_NOT_ACTIVE' using errcode = '22023'; end if;
  if v_sub.meter_id is null then raise exception 'NO_METER_LINKED' using errcode = '22023'; end if;

  select * into v_meter from smart_meters where id = v_sub.meter_id;
  if not v_meter.supports_remote_control then
    raise exception 'METER_NO_REMOTE_CONTROL' using errcode = '22023';
  end if;
  if v_meter.confirmed_amps is null then
    -- we must know the meter's real value before asking it to change
    raise exception 'NO_CONFIRMED_READING' using errcode = '22023';
  end if;

  v_limit := least(v_meter.max_amps, coalesce(v_sub.max_connection_amps, v_meter.max_amps));
  if p_requested_amps is null or p_requested_amps < v_meter.min_amps or p_requested_amps > v_limit then
    raise exception 'AMPS_OUT_OF_RANGE:%-%', v_meter.min_amps, v_limit using errcode = '22023';
  end if;
  if mod(p_requested_amps, v_meter.step_amps) <> 0 then
    raise exception 'AMPS_BAD_STEP:%', v_meter.step_amps using errcode = '22023';
  end if;
  if p_requested_amps = v_meter.confirmed_amps then
    raise exception 'NO_CHANGE' using errcode = '22023';
  end if;
  if exists (select 1 from meter_commands where meter_id = v_meter.id and status in ('pending','sent')) then
    raise exception 'CONFLICT_COMMAND_IN_PROGRESS' using errcode = 'P0001';
  end if;

  select * into v_settings from meter_settings where id = 1;
  insert into meter_commands(id, subscription_id, meter_id, previous_amps, requested_amps,
                             note, requested_by, expires_at)
  values (p_command_id, v_sub.id, v_meter.id, v_meter.confirmed_amps, p_requested_amps,
          p_note, auth.uid(), now() + make_interval(secs => v_settings.command_ttl_seconds))
  returning * into v_cmd;
  return v_cmd;
end $$;

-- Only a command not yet sent can be cancelled — once sent the meter
-- may apply it, and the next reading will tell the truth either way.
create or replace function cancel_amp_command(p_command_id uuid) returns meter_commands
language plpgsql security definer set search_path = public as $$
declare v_cmd meter_commands;
begin
  perform amp_require_manager();
  select * into v_cmd from meter_commands where id = p_command_id for update;
  if not found then raise exception 'COMMAND_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_cmd.status = 'cancelled' then return v_cmd; end if;
  if v_cmd.status <> 'pending' or v_cmd.attempts > 0 then
    raise exception 'CONFLICT_COMMAND_ALREADY_SENT' using errcode = 'P0001';
  end if;
  update meter_commands set status = 'cancelled', lease_until = null where id = p_command_id
  returning * into v_cmd;
  return v_cmd;
end $$;

create or replace function link_meter(p_subscription_id uuid, p_meter_id uuid)
returns amp_subscriptions
language plpgsql security definer set search_path = public as $$
declare v_sub amp_subscriptions; v_other uuid;
begin
  perform amp_require_manager();
  select * into v_sub from amp_subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_sub.meter_id = p_meter_id then return v_sub; end if;
  if v_sub.meter_id is not null then
    raise exception 'CONFLICT_ALREADY_LINKED' using errcode = 'P0001';
  end if;
  select id into v_other from amp_subscriptions where meter_id = p_meter_id;
  if found then raise exception 'CONFLICT_METER_IN_USE' using errcode = 'P0001'; end if;
  if not exists (select 1 from smart_meters where id = p_meter_id and active) then
    raise exception 'METER_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform amp_internal_on();
  update amp_subscriptions set meter_id = p_meter_id, meter_linked_at = now()
   where id = p_subscription_id returning * into v_sub;
  update smart_meters set next_poll_at = now() where id = p_meter_id;   -- read it right away
  perform amp_internal_off();
  perform amp_resolve_alerts('unlinked_subscription', v_sub.id, null, 'meter linked');
  return v_sub;
end $$;

create or replace function unlink_meter(p_subscription_id uuid) returns amp_subscriptions
language plpgsql security definer set search_path = public as $$
declare v_sub amp_subscriptions;
begin
  perform amp_require_manager();
  select * into v_sub from amp_subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_sub.meter_id is null then return v_sub; end if;
  if exists (select 1 from meter_commands where meter_id = v_sub.meter_id and status in ('pending','sent')) then
    raise exception 'CONFLICT_COMMAND_IN_PROGRESS' using errcode = 'P0001';
  end if;
  perform amp_internal_on();
  update amp_subscriptions set meter_id = null, meter_linked_at = null
   where id = p_subscription_id returning * into v_sub;
  perform amp_internal_off();
  return v_sub;
end $$;

create or replace function resolve_meter_alert(p_alert_id uuid, p_note text)
returns meter_alerts
language plpgsql security definer set search_path = public as $$
declare v_alert meter_alerts;
begin
  perform amp_require_manager();
  update meter_alerts
     set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), resolution_note = p_note
   where id = p_alert_id and status = 'open'
  returning * into v_alert;
  if not found then select * into v_alert from meter_alerts where id = p_alert_id; end if;
  return v_alert;
end $$;

-- ---------------------------------------------------------------------
-- run_meter_health_check — offline meters, unlinked subscriptions,
-- system/meter mismatches, expired commands. Safe to run repeatedly.
-- ---------------------------------------------------------------------
create or replace function run_meter_health_check() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_settings meter_settings;
  v_offline  int;
  v_unlinked int;
  v_mismatch int;
  v_expired  int;
  r          record;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and coalesce("current_role"()::text, '') not in ('owner','factory_manager') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_settings from meter_settings where id = 1;

  -- 1. silent meters → offline
  perform amp_internal_on();
  for r in
    update smart_meters set connection_status = 'offline'
     where active and connection_status <> 'offline'
       and coalesce(last_seen_at, created_at) < now() - make_interval(secs => v_settings.offline_after_seconds)
    returning id, serial_no, confirmed_amps, confirmed_at
  loop
    perform amp_raise_alert('meter_offline', null, r.id,
      format('Meter %s has not answered for over %s s; last confirmed value %s A',
             r.serial_no, v_settings.offline_after_seconds, coalesce(r.confirmed_amps::text, '—')),
      jsonb_build_object('confirmed_amps', r.confirmed_amps, 'confirmed_at', r.confirmed_at));
  end loop;
  perform amp_internal_off();
  select count(*) into v_offline from smart_meters where active and connection_status = 'offline';

  -- 2. active subscriptions without a meter
  for r in select id, subscription_no from amp_subscriptions where status = 'active' and meter_id is null loop
    perform amp_raise_alert('unlinked_subscription', r.id, null,
      format('Subscription %s has no smart meter linked', r.subscription_no));
  end loop;
  select count(*) into v_unlinked from amp_subscriptions where status = 'active' and meter_id is null;
  update meter_alerts a set status = 'resolved', resolved_at = now(), resolution_note = 'linked or inactive'
    from amp_subscriptions s
   where a.status = 'open' and a.kind = 'unlinked_subscription' and s.id = a.subscription_id
     and (s.meter_id is not null or s.status <> 'active');

  -- 3. registered ≠ confirmed meter value (e.g. above technical limit)
  v_mismatch := 0;
  for r in
    select s.id sub_id, s.subscription_no, s.registered_amps, m.id meter_id, m.serial_no, m.confirmed_amps
      from amp_subscriptions s join smart_meters m on m.id = s.meter_id
     where s.status = 'active' and m.confirmed_amps is not null and m.confirmed_amps <> s.registered_amps
  loop
    v_mismatch := v_mismatch + 1;
    perform amp_raise_alert('discrepancy', r.sub_id, r.meter_id,
      format('Subscription %s: system %s A, meter %s %s A',
             r.subscription_no, r.registered_amps, r.serial_no, r.confirmed_amps),
      jsonb_build_object('registered_amps', r.registered_amps, 'meter_amps', r.confirmed_amps));
  end loop;

  update meter_alerts a set status = 'resolved', resolved_at = now(), resolution_note = 'values match'
    from amp_subscriptions s join smart_meters m on m.id = s.meter_id
   where a.status = 'open' and a.kind in ('discrepancy','limit_violation') and a.subscription_id = s.id
     and m.confirmed_amps = s.registered_amps;

  v_expired := meter_expire_commands();

  return jsonb_build_object(
    'checked_at',          now(),
    'offline_meters',      v_offline,
    'unlinked_subs',       v_unlinked,
    'mismatches',          v_mismatch,
    'expired_commands',    v_expired,
    'failed_commands_24h', (select count(*) from meter_commands
                             where status in ('failed','expired') and updated_at > now() - interval '24 hours'),
    'open_alerts',         (select count(*) from meter_alerts where status = 'open')
  );
end $$;

-- =====================================================================
-- Report views (security_invoker → caller's RLS applies)
-- =====================================================================
create view amp_subscription_overview with (security_invoker = true) as
select
  s.id, s.subscription_no, s.subscriber_name, s.status,
  s.registered_amps, s.max_connection_amps,
  m.id                         as meter_id,
  m.serial_no                  as meter_serial_no,
  m.confirmed_amps             as meter_amps,
  m.confirmed_at               as meter_confirmed_at,
  m.connection_status,
  m.last_seen_at,
  m.last_sync_at,
  m.supports_remote_control,
  m.supports_push,
  (m.confirmed_amps is not null and m.confirmed_amps = s.registered_amps) as in_sync,
  c.id                         as active_command_id,
  c.status                     as active_command_status,
  c.requested_amps             as active_command_amps
from amp_subscriptions s
left join smart_meters m on m.id = s.meter_id
left join meter_commands c on c.meter_id = m.id and c.status in ('pending','sent');

create view amp_change_report with (security_invoker = true) as
select
  l.id, l.changed_at, l.recorded_at, l.source,
  s.subscription_no, s.subscriber_name,
  m.serial_no as meter_serial_no,
  l.previous_amps, l.new_amps, l.new_amps - l.previous_amps as delta_amps,
  p.full_name as actor_name, l.command_id,
  a.amount as adjustment_amount, a.effective_from as adjustment_effective_from, a.status as adjustment_status
from amp_change_log l
join amp_subscriptions s on s.id = l.subscription_id
join smart_meters m      on m.id = l.meter_id
left join profiles p     on p.id = l.actor_id
left join amp_billing_adjustments a on a.change_id = l.id;

-- =====================================================================
-- RLS
-- =====================================================================
alter table meter_settings          enable row level security;
alter table smart_meters            enable row level security;
alter table amp_subscriptions       enable row level security;
alter table meter_readings          enable row level security;
alter table meter_commands          enable row level security;
alter table amp_change_log          enable row level security;
alter table amp_price_policies      enable row level security;
alter table amp_invoices            enable row level security;
alter table amp_billing_adjustments enable row level security;
alter table meter_alerts            enable row level security;

-- read: staff
create policy meter_settings_read  on meter_settings          for select using ("current_role"() in ('owner','factory_manager','accountant','cashier'));
create policy smart_meters_read    on smart_meters            for select using ("current_role"() in ('owner','factory_manager','accountant','cashier'));
create policy amp_subs_read        on amp_subscriptions       for select using ("current_role"() in ('owner','factory_manager','accountant','cashier'));
create policy meter_readings_read  on meter_readings          for select using ("current_role"() in ('owner','factory_manager','accountant'));
create policy meter_commands_read  on meter_commands          for select using ("current_role"() in ('owner','factory_manager','accountant','cashier'));
create policy amp_change_log_read  on amp_change_log          for select using ("current_role"() in ('owner','factory_manager','accountant','cashier'));
create policy amp_prices_read      on amp_price_policies      for select using ("current_role"() in ('owner','factory_manager','accountant','cashier'));
create policy amp_invoices_read    on amp_invoices            for select using ("current_role"() in ('owner','factory_manager','accountant','cashier'));
create policy amp_adj_read         on amp_billing_adjustments for select using ("current_role"() in ('owner','factory_manager','accountant'));
create policy meter_alerts_read    on meter_alerts            for select using ("current_role"() in ('owner','factory_manager','accountant'));

-- write: meters & subscriptions master data (guard triggers protect
-- meter-owned columns); pricing and settings by owner.
create policy smart_meters_insert  on smart_meters      for insert with check ("current_role"() in ('owner','factory_manager'));
create policy smart_meters_update  on smart_meters      for update using ("current_role"() in ('owner','factory_manager'));
create policy amp_subs_insert      on amp_subscriptions for insert with check ("current_role"() in ('owner','factory_manager'));
create policy amp_subs_update      on amp_subscriptions for update using ("current_role"() in ('owner','factory_manager'));
create policy amp_prices_write     on amp_price_policies for all using ("current_role"() = 'owner') with check ("current_role"() = 'owner');
create policy meter_settings_write on meter_settings     for update using ("current_role"() = 'owner');
create policy amp_invoices_write   on amp_invoices       for all using ("current_role"() in ('owner','accountant'))
                                                        with check ("current_role"() in ('owner','accountant'));
-- meter_readings, meter_commands, amp_change_log, amp_billing_adjustments,
-- meter_alerts: no direct client writes — RPCs only.

-- =====================================================================
-- Grants
-- =====================================================================
grant select on meter_settings, smart_meters, amp_subscriptions, meter_readings, meter_commands,
  amp_change_log, amp_price_policies, amp_invoices, amp_billing_adjustments, meter_alerts
  to authenticated;
grant insert, update on smart_meters, amp_subscriptions to authenticated;
grant update on meter_settings to authenticated;
grant insert, update, delete on amp_price_policies, amp_invoices to authenticated;
grant select on amp_subscription_overview, amp_change_report to authenticated;

do $$
declare f text;
begin
  -- internal + gateway-only
  foreach f in array array[
    'amp_internal_on()', 'amp_internal_off()',
    'amp_raise_alert(meter_alert_kind, uuid, uuid, text, jsonb)',
    'amp_resolve_alerts(meter_alert_kind, uuid, uuid, text)',
    'amp_create_adjustment(uuid)',
    'meter_ingest_reading(uuid, text, numeric, timestamptz, meter_reading_source, text)',
    'meter_record_failure(text, text)',
    'meter_claim_poll_batch(int)',
    'meter_expire_commands()',
    'meter_claim_commands(int)',
    'meter_command_sent(uuid)',
    'meter_command_unconfirmed(uuid, text, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- management
  foreach f in array array[
    'request_amp_change(uuid, uuid, numeric, text)',
    'cancel_amp_command(uuid)',
    'link_meter(uuid, uuid)',
    'unlink_meter(uuid)',
    'resolve_meter_alert(uuid, text)',
    'run_meter_health_check()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- =====================================================================
-- Realtime
-- =====================================================================
alter publication supabase_realtime add table
  smart_meters, amp_subscriptions, meter_commands, amp_change_log,
  amp_billing_adjustments, meter_alerts;

-- =====================================================================
-- Scheduling (run once per project, needs pg_cron + pg_net and the
-- gateway secret in Vault — see docs/SMART_METERS.md):
--
--   select cron.schedule('meter-gateway-tick', '* * * * *', $$
--     select net.http_post(
--       url     := '<project-url>/functions/v1/meter-gateway/tick',
--       headers := jsonb_build_object('Authorization', 'Bearer ' ||
--                  (select decrypted_secret from vault.decrypted_secrets where name = 'meter_cron_secret'))
--     ) $$);
-- =====================================================================
