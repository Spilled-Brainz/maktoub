-- Lumi on Telegram: private chats, a shared group with the founder, daily check-ins, wins, weekly summaries
-- (approved by the client before the founder sees them), opt-in transcript sharing and the founder's daily digest.
--
-- Visibility, as promised in notice MKT-LUMI-2026-11-v2:
--   check-ins, wins, notes the client asks Lumi to pass on, urgent safety flags  → founder sees them
--   weekly summaries                                                            → founder sees them only once the client approves
--   private conversations (web and Telegram)                                    → founder reads them only while the client has sharing on
--   the group chat                                                              → the founder is in it
-- All tables: RLS on, no policies, service role only (the maktoub-companion function).

-- 1. Threads gain the Telegram rooms and a period (one private Telegram thread per week, one group thread per week).
alter table public.maktoub_companion_threads drop constraint maktoub_companion_threads_room_check;
alter table public.maktoub_companion_threads add constraint maktoub_companion_threads_room_check
  check (room in ('private', 'client', 'self', 'telegram', 'group'));
alter table public.maktoub_companion_threads drop constraint companion_room_shape;
alter table public.maktoub_companion_threads add constraint companion_room_shape check (
  (owner = 'founder' and room = 'private' and founder_uid is not null and enrolment_id is null and context_snapshot is null) or
  (owner = 'founder' and room = 'client'  and founder_uid is not null and enrolment_id is not null) or
  (owner = 'client'  and room in ('self', 'telegram', 'group') and founder_uid is null and enrolment_id is not null)
);
alter table public.maktoub_companion_threads add column period_start date;
create unique index maktoub_companion_threads_period_idx on public.maktoub_companion_threads(enrolment_id, room, period_start)
  where room in ('telegram', 'group');

-- 2. Messages: tool turns (stored so the conversation replays exactly), messages Lumi sent on its own, group speakers.
alter table public.maktoub_companion_messages add column kind text not null default 'chat'
  check (kind in ('chat', 'tool', 'outbound'));
alter table public.maktoub_companion_messages add column speaker text check (speaker in ('client', 'founder'));
alter table public.maktoub_companion_messages add column tg_message_id bigint;

-- 3. The client's Telegram link and preferences.
create table public.maktoub_lumi_links (
  enrolment_id uuid primary key references public.maktoub_enrolments(id) on delete cascade,
  tg_user_id bigint unique,
  tg_chat_id bigint unique,
  tg_username text,
  linked_at timestamptz,
  group_chat_id bigint unique,
  group_linked_at timestamptz,
  link_code_hash text unique check (link_code_hash is null or link_code_hash ~ '^[0-9a-f]{64}$'),
  link_code_expires_at timestamptz,
  nudges_on boolean not null default true,
  nudge_time time not null default '21:00',
  last_nudge_day date,
  next_spark_at timestamptz,
  share_conversations boolean not null default false,
  share_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. One check-in per client per day (Riyadh), filled in as they talk; later mentions the same day update it.
create table public.maktoub_lumi_checkins (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete cascade,
  day date not null,
  sleep_hours numeric(3,1) check (sleep_hours between 0 and 16),
  sleep_quality smallint check (sleep_quality between 1 and 10),
  trained boolean,
  movement text check (length(movement) <= 300),
  nutrition text check (nutrition in ('on_plan', 'mostly', 'off_plan')),
  nutrition_note text check (length(nutrition_note) <= 300),
  energy smallint check (energy between 1 and 10),
  mood smallint check (mood between 1 and 10),
  stress smallint check (stress between 1 and 10),
  on_mind text check (length(on_mind) <= 600),
  protocol_done text check (protocol_done in ('all', 'some', 'none')),
  protocol_note text check (length(protocol_note) <= 400),
  source text not null default 'telegram' check (source in ('telegram', 'web', 'group')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrolment_id, day)
);

-- 5. Wins and breakthroughs, in the client's own words.
create table public.maktoub_lumi_wins (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete cascade,
  quote text not null check (length(quote) between 1 and 600),
  said_on date not null,
  created_at timestamptz not null default now()
);
create index maktoub_lumi_wins_enrolment_idx on public.maktoub_lumi_wins(enrolment_id, said_on desc);

-- 6. Things the client explicitly asks Lumi to pass on, and urgent safety flags.
create table public.maktoub_lumi_notes (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete cascade,
  note text not null check (length(note) between 1 and 1000),
  urgent boolean not null default false,
  created_at timestamptz not null default now(),
  digested_at timestamptz
);
create index maktoub_lumi_notes_enrolment_idx on public.maktoub_lumi_notes(enrolment_id, created_at desc);

-- 7. Weekly summaries: drafted by Lumi on Friday, sent to the client, shared with the founder only if approved.
create table public.maktoub_lumi_weekly (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  summary text not null check (length(summary) <= 4000),
  status text not null default 'draft' check (status in ('draft', 'approved', 'declined')),
  tg_message_id bigint,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (enrolment_id, week_start)
);

create or replace function public.maktoub_lumi_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger maktoub_lumi_links_touch before update on public.maktoub_lumi_links for each row execute function public.maktoub_lumi_touch();
create trigger maktoub_lumi_checkins_touch before update on public.maktoub_lumi_checkins for each row execute function public.maktoub_lumi_touch();

alter table public.maktoub_lumi_links enable row level security;
alter table public.maktoub_lumi_checkins enable row level security;
alter table public.maktoub_lumi_wins enable row level security;
alter table public.maktoub_lumi_notes enable row level security;
alter table public.maktoub_lumi_weekly enable row level security;
revoke all on public.maktoub_lumi_links, public.maktoub_lumi_checkins, public.maktoub_lumi_wins,
  public.maktoub_lumi_notes, public.maktoub_lumi_weekly from public, anon, authenticated;
revoke all on function public.maktoub_lumi_touch() from public, anon, authenticated;

-- 8. Secrets for the Telegram webhook and the scheduler (never leave the database or the function).
insert into public.maktoub_internal_config (key, value) values
  ('lumi_tg_secret', encode(extensions.gen_random_bytes(32), 'hex')),
  ('lumi_cron_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- 9. Every 15 minutes: nudges, sparks, Friday summaries and the founder's 22:00 digest. The function does nothing
--    until the Lumi bot token is configured, and returns at once when nothing is due.
create or replace function public.maktoub_lumi_tick() returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  if not exists (select 1 from public.maktoub_lumi_links where tg_chat_id is not null) then return; end if;
  select value into v_secret from public.maktoub_internal_config where key = 'lumi_cron_secret';
  perform net.http_post(
    url := 'https://pmjvpnqmklxxpswwvbmv.supabase.co/functions/v1/maktoub-companion',
    body := '{"tick":true}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-lumi-cron', v_secret),
    timeout_milliseconds := 140000);
end $$;
revoke all on function public.maktoub_lumi_tick() from public, anon, authenticated;
select cron.schedule('maktoub-lumi-tick', '*/15 * * * *', 'select public.maktoub_lumi_tick()');
