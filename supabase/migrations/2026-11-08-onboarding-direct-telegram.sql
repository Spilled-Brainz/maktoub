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
