# ربط العدادات الذكية بنظام بيع الأمبيرات — Smart meters ⇄ amp subscriptions

> **الشرط الأساسي:** القيمة المضبوطة على العداد هي القيمة الفعلية المؤكدة. لا يمكن للنظام إظهار نجاح تعديل لم ينفذه العداد.
>
> **Ground rule:** the value configured on the meter is the only confirmed truth. Nothing can mark a change as done unless a reading taken from the meter shows it.

## كيف تتحقق المتطلبات / How each requirement is met

| المطلب | التنفيذ |
| --- | --- |
| رقم اشتراك فريد مرتبط برقم العداد التسلسلي | `amp_subscriptions.subscription_no` (unique) · `smart_meters.serial_no` (unique) · `amp_subscriptions.meter_id` (unique — عداد واحد لكل اشتراك). الربط فقط عبر `link_meter()`. |
| عرض أمبيرات النظام وأمبيرات العداد، حالة الاتصال، آخر مزامنة | `registered_amps` مقابل `smart_meters.confirmed_amps`, `connection_status`, `last_sync_at`, `last_seen_at` — شاشة `/amps` و `/amps/:id`، و view `amp_subscription_overview`. |
| تغيير على العداد ← تحديث تلقائي بعد التحقق | `meter_ingest_reading()`: القراءة تُرفض إن كانت غير منطقية (خارج حدود الجهاز) أو أقدم من آخر قيمة مؤكدة؛ وإلا يُحدَّث الاشتراك ويُسجَّل التغيير. |
| مزامنة فورية عند دعم الإشعار | `POST /meter-gateway/push` (موقّع HMAC). الإشعار **لا يُصدَّق**: البوابة تقرأ العداد فورًا وتسجل القراءة الفعلية. |
| قراءة دورية بفترة قابلة للضبط | `meter_settings.poll_interval_seconds` (افتراضي 300ث) أو `smart_meters.poll_interval_seconds` لكل عداد. العدادات التي تدعم الإشعار تُقرأ كنبضة احتياطية كل `push_heartbeat_seconds`. |
| عند الانقطاع: حفظ آخر قيمة مؤكدة والمزامنة عند العودة | الفشل (`meter_record_failure`) لا يلمس `confirmed_amps`؛ بعد `failures_before_offline` يصبح العداد `offline` مع تنبيه. أول قراءة ناجحة تُسجَّل بمصدر `reconnect_sync`. |
| تغيير الحد من النظام إن كان العداد يدعم التحكم | `request_amp_change()` — يرفض إن لم يكن `supports_remote_control`. |
| التحقق من التنفيذ قبل اعتباره ناجحًا | الأمر يمر بـ `pending → sent` فقط. `confirmed` يُضبط حصرًا داخل `meter_ingest_reading` عندما تطابق قراءة العداد القيمة المطلوبة. الواجهة تعرض حالة الأمر من الخادم وليس نجاح الإرسال. |
| منع تجاوز الحدود الفنية | الحد = `min(smart_meters.max_amps, amp_subscriptions.max_connection_amps)`، مع `min_amps` و `step_amps`. إذا وُجد العداد مضبوطًا فوق الحد يدويًا: تُعرض قيمته الحقيقية، لكن النظام لا يعتمدها ويُطلق تنبيه `limit_violation`. |
| سجل: القيمة السابقة والجديدة والوقت والمصدر | `amp_change_log` (append-only بقادح): `previous_amps`, `new_amps`, `changed_at`, `source` (`meter_push`/`meter_poll`/`reconnect_sync`/`system_command`), `actor_id`, `command_id`, `reading_id`. وكل قراءة خام في `meter_readings`. |
| عدم تعديل فواتير سابقة | `amp_invoices` الصادرة مقفلة بقادح (`INVOICE_LOCKED`)، والفرق يُسجل في `amp_billing_adjustments` ليُضاف للفاتورة القادمة. |
| احتساب الفرق وفق سياسة وتاريخ سريان | `amp_price_policies` (`price_per_amp`, `effective_from`, `proration`: `daily` نسبي باليوم أو `next_cycle` من الدورة القادمة، `billing_cycle_day`). عند غياب سياسة سارية: `needs_pricing` — لا صفر صامت. |
| إشعار الإدارة عند الاختلاف | `meter_alerts` (realtime) + شارة على تبويب «الأمبيرات» + شاشة `/amps/health`. |
| فحص السلامة | `run_meter_health_check()` كل دقيقة عبر البوابة، ويدويًا من الشاشة: عدادات غير متصلة، اشتراكات بلا عداد، اختلافات، أوامر فاشلة/منتهية، حالات فشل المزامنة. التنبيهات غير مكررة (`occurrences`). |
| إعادة المحاولة دون تكرار | معرّف القراءة ومعرّف حدث الإشعار idempotent؛ الأوامر مؤجَّرة (`lease_until`, `skip locked`) لعامل واحد؛ تُقرأ قيمة العداد **قبل** أي إعادة إرسال؛ القيمة المرسلة مطلقة (ليست زيادة)؛ معرّف الأمر يُمرَّر كـ `request_id` للمزود. |
| تقرير بجميع التغييرات | view `amp_change_report` + تقرير في `/amps/health` مع تصدير CSV. |

## Architecture

```
 meter / head-end ──push (HMAC)──▶ meter-gateway (edge fn) ──read──▶ meter
                                      │  tick (pg_cron, 1/min):
                                      │   1. commands: read → send → read back
                                      │   2. polls due
                                      │   3. run_meter_health_check()
                                      ▼
                     Postgres RPCs (service_role only)
                     meter_ingest_reading · meter_record_failure
                     meter_claim_poll_batch · meter_claim_commands
                     meter_command_sent · meter_command_unconfirmed
                                      │ realtime
                                      ▼
                     PWA (/amps, /amps/:id, /amps/health)
                     request_amp_change · cancel_amp_command · link_meter
                     unlink_meter · resolve_meter_alert   (online-only)
```

### Who can write what

* `amp_subscriptions.registered_amps` changes **only** inside `meter_ingest_reading` (guard trigger `AMPS_FROM_METER_ONLY`).
* Meter state columns (`confirmed_amps`, `connection_status`, …) are written only by the gateway RPCs (`METER_STATE_FROM_GATEWAY_ONLY`).
* `amp_change_log` and `meter_readings` are append-only.
* Gateway RPCs are executable by `service_role` only; management RPCs require `owner` / `factory_manager`.

### Command lifecycle

```
request_amp_change ─▶ pending ─(gateway reads meter, marks sent, calls head-end)─▶ sent
   sent ─(a reading == requested)───────────────▶ confirmed   ← the only success
   sent ─(meter moved to a third value)──────────▶ failed  SUPERSEDED_BY_METER_CHANGE
   sent ─(not confirmed after timeout × max attempts)▶ failed
   pending/sent ─(past command_ttl_seconds)──────▶ expired
   pending (never sent) ─(cancel_amp_command)────▶ cancelled
```

A late meter change after `failed`/`expired` is still recorded truthfully by the next read (as `meter_poll`).

### Linking a meter

`link_meter()` schedules an immediate read. If the meter's value differs from the `registered_amps` entered when the subscription was created, the meter wins: the difference is logged like any other change (source `meter_poll`) and gets a billing adjustment from the link date.

## Head-end contract (`http_headend` driver)

Meters vary by vendor (DLMS/COSEM, Modbus, vendor clouds). The gateway talks to one small REST contract; put a thin bridge in front of the vendor head-end if it speaks something else.

```
GET  {METER_HEADEND_URL}/meters/{serial}/current-limit
     → 200 { "amps": 16, "timestamp": "2026-10-24T09:00:00Z" }   # timestamp optional
PUT  {METER_HEADEND_URL}/meters/{serial}/current-limit
     { "amps": 16, "request_id": "<command uuid>" }
     → 2xx accepted · 400/409/422 refused (not retried) · anything else → retried
```

Push notifications: `POST /functions/v1/meter-gateway/push` with body `{ "serial_no": "...", "event_id": "..." }` and header `x-meter-signature: hex(HMAC-SHA256(raw body, METER_WEBHOOK_SECRET))`.

New vendors: add a `MeterDriver` in `supabase/functions/_shared/meter/drivers.ts`, register it in `meter-gateway/index.ts`, set `smart_meters.driver` to its key.

## Deploy

1. Apply migrations (`supabase db push`). `0004_smart_meter_amps.sql` depends on `0001`.
2. Secrets:
   ```
   supabase secrets set METER_WEBHOOK_SECRET=… METER_CRON_SECRET=… \
     METER_HEADEND_URL=https://… METER_HEADEND_TOKEN=…
   ```
3. `supabase functions deploy meter-gateway --no-verify-jwt`
4. Schedule the tick (pg_cron + pg_net), storing `METER_CRON_SECRET` in Vault as `meter_cron_secret` — SQL is at the end of the migration.
5. Add an `amp_price_policies` row (owner) and tune `meter_settings`.

## Settings (`meter_settings`, single row)

| column | default | meaning |
| --- | --- | --- |
| `poll_interval_seconds` | 300 | read interval for meters without push |
| `push_heartbeat_seconds` | 3600 | safety read interval for push-capable meters |
| `offline_after_seconds` | 900 | silence before a meter is marked offline |
| `failures_before_offline` | 3 | consecutive failed reads before offline |
| `command_confirm_timeout_seconds` | 120 | wait for the meter before re-sending |
| `command_max_attempts` | 3 | sends before a command fails |
| `command_ttl_seconds` | 3600 | a command not confirmed by then expires |
| `billing_timezone` | `Asia/Baghdad` | date used for effective dates / proration |

## Tests

* `npm run test:sql` — applies every migration to a plain Postgres (with `supabase/tests/_supabase_stub.sql`) and runs `supabase/tests/0004_smart_meter_amps.test.sql`: guards, RLS/grants, sync, idempotent replays, stale/implausible reads, command confirmation, technical limits, offline/reconnect, superseded commands, expiry, invoice lock, proration, health check.
* `npm test` — gateway orchestration (`supabase/functions/_shared/meter/gateway.test.ts`), client validation, sync-engine rejection path.

## Not included yet

* Invoice generation for amp subscriptions (there was no amp billing in the system). `amp_invoices` + the lock trigger and `amp_billing_adjustments` are the hooks it should use: consume `pending` adjustments as separate lines and set `applied_invoice_id`.
* Screens for creating subscriptions/meters and editing price policies — today via the Supabase table editor (RLS allows owner/manager).
