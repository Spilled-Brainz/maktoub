-- Content bot: text an idea to a private Telegram bot, get platform-native drafts back,
-- approve or schedule them, and the scheduler publishes them. Edge function: maktoub-content.
-- Everything is service-role only; the bot answers only the founder's chat.

create table public.maktoub_content_posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source_text text not null,                      -- the idea exactly as texted
  feedback text[] not null default '{}',          -- rewrite notes, oldest first
  image_path text,                                -- optional photo, bucket maktoub-content
  drafts jsonb not null default '{}',             -- { linkedin, instagram, threads, facebook, x: [..] }
  platforms text[] not null,                      -- platforms selected for this post
  status text not null default 'draft' check (status in ('draft','scheduled','publishing','published','partial','failed','discarded')),
  publish_at timestamptz,                         -- set when approved (now) or scheduled
  suggested_at timestamptz,                       -- a time the founder mentioned in the message
  control_message_id bigint,                      -- the Telegram message carrying the buttons
  results jsonb not null default '{}'             -- per platform: { ok, url?, id?, error?, manual? }
);
create index maktoub_content_due on public.maktoub_content_posts (publish_at) where status = 'scheduled';

-- Telegram retries a webhook it thinks failed; remembering update ids makes each message count once.
create table public.maktoub_content_updates (update_id bigint primary key, received_at timestamptz not null default now());

alter table public.maktoub_content_posts enable row level security;
alter table public.maktoub_content_updates enable row level security;
revoke all on public.maktoub_content_posts, public.maktoub_content_updates from public, anon, authenticated;

-- Private bucket for photos sent with an idea (Instagram needs one). Served to platforms via short signed URLs.
insert into storage.buckets (id, name, public) values ('maktoub-content', 'maktoub-content', false) on conflict (id) do nothing;

-- Optional house voice the drafts follow; edit from Telegram with /voice.
insert into public.maktoub_internal_config (key, value) values ('content_voice', '') on conflict (key) do nothing;

-- Scheduler: every 5 minutes, ask the function to publish whatever is due. pg_cron + pg_net, no n8n runs.
select cron.schedule('maktoub-content-publish', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://pmjvpnqmklxxpswwvbmv.supabase.co/functions/v1/maktoub-content',
    body := '{"action":"publish_due"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-notify-secret', (select value from public.maktoub_internal_config where key = 'notify_secret')),
    timeout_milliseconds := 60000)
$$);
