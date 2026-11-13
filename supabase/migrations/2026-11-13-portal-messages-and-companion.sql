-- Portal messages, voice deferral and the Maktoub accountability bot (13 Nov 2026).
-- Additive: two new tables, new columns on maktoub_onboarding, one relaxed step-order rule,
-- and a daily pg_cron job that wakes the maktoub-companion edge function.
-- Everything stays service-role only; edge functions are the only readers/writers.
begin;

-- 1. Voice can be deferred by the founder so the client is not held at step 3.
--    She can still record on the portal or send it as a voice note in her Telegram group.
alter table public.maktoub_onboarding
  add column voice_deferred_at timestamptz,
  add column voice_deferred_by uuid,
  add column voice_source text check (voice_source is null or voice_source in ('portal','telegram'));

alter table public.maktoub_onboarding drop constraint onboarding_step_order;
alter table public.maktoub_onboarding add constraint onboarding_step_order check (
  (intake_submitted_at is null or signed_at is not null) and
  (voice_submitted_at is null or intake_submitted_at is not null) and
  (payment_reported_at is null or voice_submitted_at is not null or voice_deferred_at is not null) and
  (payment_verified_at is null or signed_at is not null) and
  (matchmaking_started_at is null or readiness_status = 'approved')
);

-- 2. Accountability bot ("companion"): one private Telegram group per client, with the founder in it.
alter table public.maktoub_onboarding
  add column companion_chat_id bigint unique,
  add column companion_link_code_hash text,
  add column companion_link_expires_at timestamptz,
  add column companion_linked_at timestamptz,
  add column companion_client_tg_id bigint,
  add column companion_client_tg_name text,
  add column companion_paused_at timestamptz,
  add column companion_day integer not null default 0,
  add column companion_last_prompt_at timestamptz,
  add column companion_last_reply_at timestamptz,
  add column companion_streak integer not null default 0;

-- 3. Messages the founder publishes to the client's portal.
create table public.maktoub_onboarding_messages (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.maktoub_onboarding(id) on delete restrict,
  title text check (title is null or length(title) <= 140),
  body text not null check (length(body) between 1 and 6000),
  created_by uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  telegram_sent_at timestamptz,
  telegram_error text
);
create index maktoub_onboarding_messages_onb_idx on public.maktoub_onboarding_messages(onboarding_id, created_at desc);

-- 4. Everything said in the accountability group, for the founder's record.
create table public.maktoub_companion_log (
  id bigint generated always as identity primary key,
  onboarding_id uuid not null references public.maktoub_onboarding(id) on delete restrict,
  chat_id bigint not null,
  from_role text not null check (from_role in ('client','founder','bot','other')),
  kind text not null check (kind in ('prompt','reply','message','voice','command','system')),
  day integer,
  text text,
  tg_message_id bigint,
  created_at timestamptz not null default now()
);
create index maktoub_companion_log_onb_idx on public.maktoub_companion_log(onboarding_id, created_at desc);

alter table public.maktoub_onboarding_messages enable row level security;
alter table public.maktoub_companion_log enable row level security;
revoke all on public.maktoub_onboarding_messages, public.maktoub_companion_log from public, anon, authenticated;

-- Telegram signs each webhook call with this secret (X-Telegram-Bot-Api-Secret-Token).
insert into public.maktoub_internal_config (key, value)
values ('companion_webhook_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- 5. Daily prompt at 09:00 Riyadh (06:00 UTC). The function skips anyone already prompted today.
create extension if not exists pg_cron;
create or replace function public.maktoub_companion_tick() returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select value into v_secret from public.maktoub_internal_config where key = 'notify_secret';
  perform net.http_post(
    url := 'https://pmjvpnqmklxxpswwvbmv.supabase.co/functions/v1/maktoub-companion',
    body := jsonb_build_object('action', 'daily'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
    timeout_milliseconds := 30000);
end $$;
revoke all on function public.maktoub_companion_tick() from public, anon, authenticated;
select cron.schedule('maktoub-companion-daily', '0 6 * * *', 'select public.maktoub_companion_tick()');

commit;
