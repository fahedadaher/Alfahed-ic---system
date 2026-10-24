-- =====================================================================
-- Tests for 0004_smart_meter_amps.sql. Run with scripts/test-sql.sh.
-- Each block raises on failure; psql runs with ON_ERROR_STOP.
-- =====================================================================

create or replace function t_assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'ASSERTION FAILED: %', p_msg; end if;
end $$;

-- Runs p_sql and asserts it fails with an error containing p_pattern.
create or replace function t_expect_error(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_pattern in sqlerrm) = 0 then
      raise exception 'ASSERTION FAILED: expected error "%" from [%], got "%"', p_pattern, p_sql, sqlerrm;
    end if;
    return;
  end;
  raise exception 'ASSERTION FAILED: expected error "%" from [%], but it succeeded', p_pattern, p_sql;
end $$;

create or replace function t_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false)
$$;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
insert into auth.users(id) values
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003');
insert into profiles(id, full_name, role, factory_id) values
  ('a0000000-0000-0000-0000-000000000001', 'Owner',   'owner',           '00000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'Manager', 'factory_manager', '00000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000003', 'Driver',  'driver',          '00000000-0000-0000-0000-000000000001');

insert into amp_price_policies(id, name, price_per_amp, effective_from, proration)
values ('b0000000-0000-0000-0000-000000000001', 'Standard', 1000, '2026-01-01', 'daily');

insert into smart_meters(id, serial_no, supports_push, supports_remote_control, min_amps, max_amps, step_amps,
                         confirmed_amps, connection_status)
values ('c0000000-0000-0000-0000-000000000001', 'SM-001', true, true, 1, 32, 1,
        99, 'online');   -- guard must ignore the injected state on insert
insert into smart_meters(id, serial_no, supports_remote_control, max_amps)
values ('c0000000-0000-0000-0000-000000000002', 'SM-002', false, 32);

insert into amp_subscriptions(id, subscription_no, subscriber_name, registered_amps, max_connection_amps)
values ('d0000000-0000-0000-0000-000000000001', 'SUB-1001', 'Subscriber A', 10, 20),
       ('d0000000-0000-0000-0000-000000000002', 'SUB-1002', 'Subscriber B', 5, null);

-- ---------------------------------------------------------------------
do $$ begin
  perform t_assert((select confirmed_amps is null and connection_status = 'unknown'
                      from smart_meters where serial_no = 'SM-001'),
                   'insert cannot inject meter state');
end $$;

-- ---------------------------------------------------------------------
-- Guards: registered amps / meter state / links only via RPC & meter
-- ---------------------------------------------------------------------
select t_as('a0000000-0000-0000-0000-000000000002');
do $$ begin
  perform t_expect_error($q$update amp_subscriptions set registered_amps = 15 where subscription_no = 'SUB-1001'$q$,
                         'AMPS_FROM_METER_ONLY');
  perform t_expect_error($q$update smart_meters set confirmed_amps = 15 where serial_no = 'SM-001'$q$,
                         'METER_STATE_FROM_GATEWAY_ONLY');
  perform t_expect_error($q$update amp_subscriptions set meter_id = 'c0000000-0000-0000-0000-000000000001'
                            where subscription_no = 'SUB-1001'$q$, 'USE_LINK_METER');
end $$;

-- Same, through RLS as the authenticated role
set role authenticated;
do $$ begin
  perform t_expect_error($q$update amp_subscriptions set registered_amps = 15 where subscription_no = 'SUB-1001'$q$,
                         'AMPS_FROM_METER_ONLY');
  -- master-data edits remain possible
  update amp_subscriptions set phone = '0770' where subscription_no = 'SUB-1001';
  perform t_assert((select phone from amp_subscriptions where subscription_no = 'SUB-1001') = '0770', 'phone edit');
  -- gateway RPCs are not callable by clients
  perform t_expect_error($q$select meter_ingest_reading(gen_random_uuid(), 'SM-001', 30, null, 'poll')$q$,
                         'permission denied');
  perform t_expect_error($q$select meter_record_failure('SM-001', 'x')$q$, 'permission denied');
  -- readings / change log / commands are not writable directly
  perform t_expect_error($q$insert into meter_commands(id, subscription_id, meter_id, requested_amps, requested_by, expires_at)
                            values (gen_random_uuid(), 'd0000000-0000-0000-0000-000000000001',
                                    'c0000000-0000-0000-0000-000000000001', 16,
                                    'a0000000-0000-0000-0000-000000000002', now())$q$, 'permission denied');
end $$;
reset role;

-- ---------------------------------------------------------------------
-- Linking
-- ---------------------------------------------------------------------
select t_as('a0000000-0000-0000-0000-000000000003');   -- driver
do $$ begin
  perform t_expect_error($q$select link_meter('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001')$q$,
                         'FORBIDDEN');
end $$;
select t_as('a0000000-0000-0000-0000-000000000002');   -- manager
select link_meter('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001');
do $$ begin
  perform t_expect_error($q$select link_meter('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001')$q$,
                         'CONFLICT_METER_IN_USE');
  -- no command before the meter's real value is known
  perform t_expect_error($q$select request_amp_change(gen_random_uuid(), 'd0000000-0000-0000-0000-000000000001', 16)$q$,
                         'NO_CONFIRMED_READING');
end $$;

-- ---------------------------------------------------------------------
-- Readings → automatic sync
-- ---------------------------------------------------------------------
do $$
declare r jsonb;
begin
  -- matches the system: no change
  r := meter_ingest_reading('e0000000-0000-0000-0000-000000000001', 'SM-001', 10, '2026-10-15 09:00+03', 'poll');
  perform t_assert(r->>'status' = 'accepted' and (r->>'changed')::boolean = false, 'reading 10 accepted, unchanged');
  perform t_assert((select connection_status = 'online' and confirmed_amps = 10 from smart_meters where serial_no = 'SM-001'),
                   'meter online at 10');

  -- meter lowered/raised locally → push → subscription follows
  r := meter_ingest_reading('e0000000-0000-0000-0000-000000000002', 'SM-001', 12, '2026-10-16 09:00+03', 'push', 'evt-1');
  perform t_assert((r->>'changed')::boolean and r->>'source' = 'meter_push', 'push change: ' || r::text);
  perform t_assert((select registered_amps from amp_subscriptions where subscription_no = 'SUB-1001') = 12,
                   'registered follows meter');
  perform t_assert((select count(*) from amp_change_log) = 1, 'one change logged');
  perform t_assert((select previous_amps = 10 and new_amps = 12 and source = 'meter_push'
                      and changed_at = '2026-10-16 09:00+03' from amp_change_log), 'log has prev/new/time/source');

  -- billing: +2 A × 1000 × 16/31 days (Oct 16 → Nov 1)
  perform t_assert((select amount = 1032.26 and days_charged = 16 and days_in_period = 31
                      and effective_from = '2026-10-16' and status = 'pending'
                      from amp_billing_adjustments), 'prorated adjustment');

  -- idempotent replays: same reading id, same push event id
  r := meter_ingest_reading('e0000000-0000-0000-0000-000000000002', 'SM-001', 12, '2026-10-16 09:00+03', 'push', 'evt-1');
  perform t_assert((r->>'replay')::boolean, 'replay by reading id');
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 12, '2026-10-16 09:00+03', 'push', 'evt-1');
  perform t_assert((r->>'replay')::boolean, 'replay by event id');
  perform t_assert((select count(*) from amp_change_log) = 1, 'replays add no change');
  perform t_assert((select count(*) from amp_billing_adjustments) = 1, 'replays add no adjustment');

  -- out-of-order reading is ignored
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 8, '2026-10-15 10:00+03', 'poll');
  perform t_assert(r->>'reason' = 'STALE_READING', 'stale rejected');
  perform t_assert((select registered_amps from amp_subscriptions where subscription_no = 'SUB-1001') = 12, 'stale ignored');

  -- a meter clock running ahead is clamped to server time
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 12, now() + interval '2 hours', 'poll');
  perform t_assert((select confirmed_at <= now() from smart_meters where serial_no = 'SM-001'), 'future device time clamped');
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 12, null, 'poll');
  perform t_assert(r->>'status' = 'accepted', 'later read without device time not stale: ' || r::text);

    -- implausible value is recorded, rejected, alerted
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 999999999, null, 'poll');
  perform t_assert(r->>'reason' = 'IMPLAUSIBLE_VALUE', 'implausible rejected');
  perform t_assert((select confirmed_amps from smart_meters where serial_no = 'SM-001') = 12, 'implausible not confirmed');
  perform t_assert(exists (select 1 from meter_alerts where kind = 'sync_failed' and status = 'open'), 'sync_failed alert');
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 12, null, 'poll');
  perform t_assert(not exists (select 1 from meter_alerts where kind = 'sync_failed' and status = 'open'),
                   'good read resolves sync_failed');
end $$;

-- ---------------------------------------------------------------------
-- Commands: validated, never "done" until the meter shows the value
-- ---------------------------------------------------------------------
do $$
declare c meter_commands; n int; r jsonb;
begin
  perform t_expect_error($q$select request_amp_change(gen_random_uuid(), 'd0000000-0000-0000-0000-000000000001', 25)$q$,
                         'AMPS_OUT_OF_RANGE');        -- connection limit 20
  perform t_expect_error($q$select request_amp_change(gen_random_uuid(), 'd0000000-0000-0000-0000-000000000001', 0)$q$,
                         'AMPS_OUT_OF_RANGE');        -- below meter minimum
  perform t_expect_error($q$select request_amp_change(gen_random_uuid(), 'd0000000-0000-0000-0000-000000000001', 12.5)$q$,
                         'AMPS_BAD_STEP');
  perform t_expect_error($q$select request_amp_change(gen_random_uuid(), 'd0000000-0000-0000-0000-000000000001', 12)$q$,
                         'NO_CHANGE');

  c := request_amp_change('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 16, 'upgrade');
  perform t_assert(c.status = 'pending' and c.previous_amps = 12, 'command pending');
  perform t_assert((select registered_amps from amp_subscriptions where subscription_no = 'SUB-1001') = 12,
                   'request does not change registered amps');
  -- idempotent replay of the same request
  c := request_amp_change('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 16, 'upgrade');
  perform t_assert((select count(*) from meter_commands) = 1, 'replay creates no second command');
  perform t_expect_error($q$select request_amp_change(gen_random_uuid(), 'd0000000-0000-0000-0000-000000000001', 18)$q$,
                         'CONFLICT_COMMAND_IN_PROGRESS');

  -- gateway: claim is leased to one worker
  select count(*) into n from meter_claim_commands(10);
  perform t_assert(n = 1, 'claimed once');
  select count(*) into n from meter_claim_commands(10);
  perform t_assert(n = 0, 'lease prevents double processing');

  c := meter_command_sent('f0000000-0000-0000-0000-000000000001');
  perform t_assert(c.status = 'sent' and c.attempts = 1, 'sent, not confirmed');

  -- meter still shows the old value → not confirmed
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 12, null, 'command_verify');
  perform t_assert((select status from meter_commands where id = 'f0000000-0000-0000-0000-000000000001') = 'sent',
                   'old value does not confirm');
  c := meter_command_unconfirmed('f0000000-0000-0000-0000-000000000001', 'NOT_CONFIRMED');
  perform t_assert(c.status = 'sent' and c.next_attempt_at > now(), 'retry scheduled with backoff');
  perform t_assert((select registered_amps from amp_subscriptions where subscription_no = 'SUB-1001') = 12,
                   'still 12 until the meter confirms');

  -- meter now shows the requested value → confirmed
  r := meter_ingest_reading('e0000000-0000-0000-0000-000000000010', 'SM-001', 16, null, 'command_verify');
  perform t_assert(r->>'command' = 'confirmed' and r->>'source' = 'system_command', 'confirmed: ' || r::text);
  perform t_assert((select status = 'confirmed' and confirmed_reading_id = 'e0000000-0000-0000-0000-000000000010'
                      from meter_commands where id = 'f0000000-0000-0000-0000-000000000001'), 'command confirmed by reading');
  perform t_assert((select actor_id = 'a0000000-0000-0000-0000-000000000002' and command_id is not null
                      from amp_change_log where new_amps = 16), 'change attributed to requester');
end $$;

-- ---------------------------------------------------------------------
-- Technical limit: meter set above what the connection allows
-- ---------------------------------------------------------------------
do $$
declare r jsonb; h jsonb;
begin
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 30, null, 'poll');
  perform t_assert(r->>'reason' = 'ABOVE_TECHNICAL_LIMIT', 'limit flagged');
  perform t_assert((select confirmed_amps from smart_meters where serial_no = 'SM-001') = 30, 'meter truth shown');
  perform t_assert((select registered_amps from amp_subscriptions where subscription_no = 'SUB-1001') = 16,
                   'system does not adopt over-limit value');
  perform t_assert(exists (select 1 from meter_alerts where kind = 'limit_violation' and status = 'open'), 'limit alert');

  h := run_meter_health_check();
  perform t_assert((h->>'mismatches')::int = 1, 'health check sees mismatch: ' || h::text);
  perform t_assert(exists (select 1 from meter_alerts where kind = 'discrepancy' and status = 'open'), 'discrepancy alert');

  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 16, null, 'poll');
  perform t_assert(not exists (select 1 from meter_alerts where kind in ('discrepancy','limit_violation') and status = 'open'),
                   'alerts resolved once values match');
end $$;

-- ---------------------------------------------------------------------
-- Offline: last confirmed value kept; sync on reconnect
-- ---------------------------------------------------------------------
do $$
declare m smart_meters; r jsonb;
begin
  m := meter_record_failure('SM-001', 'timeout');
  m := meter_record_failure('SM-001', 'timeout');
  perform t_assert(m.connection_status = 'online', 'not offline before threshold');
  m := meter_record_failure('SM-001', 'timeout');
  perform t_assert(m.connection_status = 'offline' and m.confirmed_amps = 16 and m.consecutive_failures = 3,
                   'offline keeps last confirmed value');
  perform t_assert((select occurrences from meter_alerts where kind = 'sync_failed' and status = 'open') = 3,
                   'repeated failures de-duplicated into one alert');
  perform t_assert(exists (select 1 from meter_alerts where kind = 'meter_offline' and status = 'open'), 'offline alert');

  -- the meter was changed while we could not see it
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 14, null, 'poll');
  perform t_assert(r->>'source' = 'reconnect_sync', 'reconnect source: ' || r::text);
  perform t_assert((select connection_status from smart_meters where serial_no = 'SM-001') = 'online', 'back online');
  perform t_assert(not exists (select 1 from meter_alerts where kind = 'meter_offline' and status = 'open'),
                   'offline alert resolved');
end $$;

-- ---------------------------------------------------------------------
-- Local meter change while a command is in flight → never overridden
-- ---------------------------------------------------------------------
do $$
declare c meter_commands; r jsonb;
begin
  c := request_amp_change('f0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 18);
  c := meter_command_sent(c.id);
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 10, null, 'poll');
  perform t_assert(r->>'command' = 'superseded', 'superseded: ' || r::text);
  perform t_assert((select status = 'failed' and last_error = 'SUPERSEDED_BY_METER_CHANGE'
                      from meter_commands where id = 'f0000000-0000-0000-0000-000000000002'), 'command failed');
  perform t_assert((select registered_amps from amp_subscriptions where subscription_no = 'SUB-1001') = 10,
                   'system follows the meter');
  -- a failed command cannot be re-sent
  c := meter_command_sent('f0000000-0000-0000-0000-000000000002');
  perform t_assert(c.status = 'failed' and c.attempts = 1, 'no send after failure');
end $$;

-- ---------------------------------------------------------------------
-- Max attempts, expiry, cancel
-- ---------------------------------------------------------------------
do $$
declare c meter_commands; h jsonb;
begin
  c := request_amp_change('f0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 12);
  c := meter_command_sent(c.id);  c := meter_command_unconfirmed(c.id, 'NOT_CONFIRMED');
  c := meter_command_sent(c.id);  c := meter_command_unconfirmed(c.id, 'NOT_CONFIRMED');
  c := meter_command_sent(c.id);  c := meter_command_unconfirmed(c.id, 'NOT_CONFIRMED');
  perform t_assert(c.status = 'failed' and c.attempts = 3, 'fails after max attempts');
  perform t_assert(exists (select 1 from meter_alerts where kind = 'command_failed' and status = 'open'), 'command alert');

  c := request_amp_change('f0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000001', 12);
  update meter_commands set expires_at = now() - interval '1 second' where id = c.id;
  h := run_meter_health_check();
  perform t_assert((h->>'expired_commands')::int = 1, 'expired: ' || h::text);
  perform t_assert((select status from meter_commands where id = c.id) = 'expired', 'command expired');

  c := request_amp_change('f0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001', 12);
  c := cancel_amp_command(c.id);
  perform t_assert(c.status = 'cancelled', 'pending can be cancelled');
  c := request_amp_change('f0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000001', 12);
  c := meter_command_sent(c.id);
  perform t_expect_error($q$select cancel_amp_command('f0000000-0000-0000-0000-000000000006')$q$,
                         'CONFLICT_COMMAND_ALREADY_SENT');
  perform t_expect_error($q$select unlink_meter('d0000000-0000-0000-0000-000000000001')$q$,
                         'CONFLICT_COMMAND_IN_PROGRESS');
  perform meter_command_unconfirmed(c.id, 'REFUSED_BY_METER', true);
  perform t_assert((select status from meter_commands where id = c.id) = 'failed', 'permanent failure');

  -- remote control unsupported
  perform link_meter('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002');
  perform meter_ingest_reading(gen_random_uuid(), 'SM-002', 5, null, 'poll');
  perform t_expect_error($q$select request_amp_change(gen_random_uuid(), 'd0000000-0000-0000-0000-000000000002', 6)$q$,
                         'METER_NO_REMOTE_CONTROL');
  perform unlink_meter('d0000000-0000-0000-0000-000000000002');
end $$;

-- ---------------------------------------------------------------------
-- Health: unlinked subscriptions, silent meters
-- ---------------------------------------------------------------------
do $$
declare h jsonb;
begin
  h := run_meter_health_check();
  perform t_assert((h->>'unlinked_subs')::int = 1, 'unlinked counted: ' || h::text);
  perform t_assert(exists (select 1 from meter_alerts where kind = 'unlinked_subscription' and status = 'open'
                             and subscription_id = 'd0000000-0000-0000-0000-000000000002'), 'unlinked alert');

  perform amp_internal_on();
  update smart_meters set last_seen_at = now() - interval '2 hours' where serial_no = 'SM-001';
  perform amp_internal_off();
  h := run_meter_health_check();
  perform t_assert((select connection_status from smart_meters where serial_no = 'SM-001') = 'offline', 'silent → offline');

  perform link_meter('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002');
  perform t_assert(not exists (select 1 from meter_alerts where kind = 'unlinked_subscription' and status = 'open'),
                   'linking resolves unlinked alert');
end $$;

select t_as('a0000000-0000-0000-0000-000000000003');   -- driver cannot run the check
do $$ begin
  perform t_expect_error('select run_meter_health_check()', 'FORBIDDEN');
end $$;
select t_as('a0000000-0000-0000-0000-000000000002');

-- ---------------------------------------------------------------------
-- Accounting: log is append-only, issued invoices never change
-- ---------------------------------------------------------------------
do $$
declare v_inv uuid; r jsonb;
begin
  perform t_expect_error('update amp_change_log set new_amps = 1', 'APPEND_ONLY');
  perform t_expect_error('delete from amp_change_log', 'APPEND_ONLY');
  perform t_expect_error('delete from meter_readings', 'APPEND_ONLY');

  insert into amp_invoices(subscription_id, period_start, period_end, amps, amount, status, issued_at)
  values ('d0000000-0000-0000-0000-000000000001', '2026-10-01', '2026-11-01', 10, 10000, 'issued', now())
  returning id into v_inv;
  perform t_expect_error(format('update amp_invoices set amount = 1 where id = %L', v_inv), 'INVOICE_LOCKED');
  perform t_expect_error(format('delete from amp_invoices where id = %L', v_inv), 'INVOICE_LOCKED');

  -- a new change after issuing creates an adjustment, never an invoice edit
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 15, null, 'poll');
  perform t_assert((r->>'changed')::boolean, 'change after invoice');
  perform t_assert((select amount = 10000 and amps = 10 from amp_invoices where id = v_inv), 'invoice untouched');
  perform t_assert((select count(*) from amp_billing_adjustments where applied_invoice_id is null)
                   = (select count(*) from amp_change_log), 'every change has an unapplied adjustment');

  update amp_invoices set status = 'void' where id = v_inv;
  perform t_expect_error(format('update amp_invoices set status = %L where id = %L', 'issued', v_inv), 'INVOICE_LOCKED');
end $$;

-- ---------------------------------------------------------------------
-- Pricing policy by effective date: next_cycle and missing policy
-- ---------------------------------------------------------------------
do $$
declare r jsonb;
begin
  insert into amp_price_policies(name, price_per_amp, effective_from, proration)
  values ('From next cycle', 1200, (now() at time zone 'Asia/Baghdad')::date, 'next_cycle');
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 13, null, 'poll');
  perform t_assert((select amount = 0 and days_charged = 0
                      and effective_from = (date_trunc('month', now() at time zone 'Asia/Baghdad') + interval '1 month')::date
                      from amp_billing_adjustments where change_id = (r->>'change_id')::uuid),
                   'next_cycle: no difference this cycle, effective next');

  update amp_price_policies set active = false;
  r := meter_ingest_reading(gen_random_uuid(), 'SM-001', 11, null, 'poll');
  perform t_assert((select status = 'needs_pricing' and amount is null
                      from amp_billing_adjustments where change_id = (r->>'change_id')::uuid),
                   'no policy → needs_pricing, never a silent zero');
end $$;

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------
do $$ begin
  perform t_assert((select meter_amps = 11 and registered_amps = 11 and in_sync
                      from amp_subscription_overview where subscription_no = 'SUB-1001'), 'status view');
  perform t_assert((select count(*) from amp_change_report) = (select count(*) from amp_change_log), 'change report');
end $$;

select 'ALL SMART METER TESTS PASSED' as result;
