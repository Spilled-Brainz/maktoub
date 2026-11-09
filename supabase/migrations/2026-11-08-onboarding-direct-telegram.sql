-- Onboarding alerts go straight to Telegram via the maktoub-notify edge function (no n8n).
-- Applied 8 Nov 2026 after n8n stopped running (plan execution limit), which silenced the first client's alerts.
create table public.maktoub_internal_config (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.maktoub_internal_config enable row level security;
revoke all on public.maktoub_internal_config from public, anon, authenticated;
insert into public.maktoub_internal_config (key, value) values ('notify_secret', encode(extensions.gen_random_bytes(32), 'hex'));

create function public.maktoub_outbox_push_onboarding() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  if new.kind like 'onboarding_%' then
    select value into v_secret from public.maktoub_internal_config where key = 'notify_secret';
    perform net.http_post(
      url := 'https://pmjvpnqmklxxpswwvbmv.supabase.co/functions/v1/maktoub-notify',
      body := jsonb_build_object('outbox_id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
      timeout_milliseconds := 10000);
  end if;
  return new;
end $$;
revoke all on function public.maktoub_outbox_push_onboarding() from public, anon, authenticated;
create trigger maktoub_outbox_push_onboarding after insert on public.maktoub_notification_outbox
  for each row execute function public.maktoub_outbox_push_onboarding();

-- maktoub_next_notification() (n8n) now selects `sent_at is null and kind not like 'onboarding_%'`
-- so the two senders never handle the same alert. See the live definition for the full body.
-- The edge function needs the secret MAKTOUB_TELEGRAM_BOT_TOKEN (Supabase → Edge Functions → Secrets).

-- Later the same day: maktoub_next_notification() handles onboarding_* again as a fallback (selects any unsent row),
-- so whichever sender is available delivers the alert. maktoub-notify marks rows sent immediately, so n8n
-- only sees them if the direct sender has no bot token. maktoub-notify accepts the token as
-- MAKTOUB_TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_TOKEN, TG_BOT_TOKEN or BOT_TOKEN.

-- n8n usage fix (8 Nov 2026): alerts are event-driven instead of polled every 5 minutes.
-- maktoub_internal_config('n8n_outbox_webhook') holds the n8n webhook URL ("Alert queued (Supabase)" node).
-- maktoub_outbox_push_onboarding() now also POSTs that webhook for every non-onboarding alert;
-- maktoub-notify hands over to it when it has no bot token. n8n keeps a 6-hourly safety-net schedule,
-- and the calendar busy-time sync runs hourly. Expected usage ~900 runs/month (was ~11,000).

-- 9 Nov 2026: voice-note alerts include a private listen link.
-- maktoub_onboarding.voice_share_url / voice_share_expires_at hold a 7-day signed URL that maktoub-notify
-- issues when a voice-note alert is queued; maktoub_next_notification() returns it as voice_url (+ voice_seconds)
-- and the n8n Compose node adds "Listen to her voice note" to the Telegram message.
alter table public.maktoub_onboarding add column voice_share_url text, add column voice_share_expires_at timestamptz;
