-- Maktoub Companion: a private AI conversation inside the portal.
--
-- Three rooms, one set of tables:
--   founder / private  — the founder alone. No client data is ever attached.
--   founder / client   — the founder thinking about one named client. That client's record is read ONCE,
--                        when the thread is opened, frozen into the thread (context_snapshot) and logged
--                        in that client's audit trail. Identifiers are stripped before it is frozen.
--   client  / self     — a programme client, from their own private link, about their own programme.
--                        The founder cannot read these conversations; only that they exist and when last used.
--
-- The model is Claude, called only from the maktoub-companion edge function. Nothing here is reachable
-- by anon or authenticated roles: RLS is on with no policies, so only the service role can read or write.

create table public.maktoub_companion_threads (
  id uuid primary key default gen_random_uuid(),
  owner text not null check (owner in ('founder', 'client')),
  room text not null check (room in ('private', 'client', 'self')),
  founder_uid uuid,                        -- owner = founder
  enrolment_id uuid references public.maktoub_enrolments(id) on delete cascade,  -- owner = client (their own), or room = client (the subject)
  title text not null default 'New conversation' check (length(title) <= 120),
  context_snapshot text,                   -- frozen once at creation; replayed byte-for-byte on every turn
  context_read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companion_room_shape check (
    (owner = 'founder' and room = 'private' and founder_uid is not null and enrolment_id is null and context_snapshot is null) or
    (owner = 'founder' and room = 'client'  and founder_uid is not null and enrolment_id is not null) or
    (owner = 'client'  and room = 'self'    and founder_uid is null     and enrolment_id is not null)
  )
);
create index maktoub_companion_threads_founder_idx on public.maktoub_companion_threads(founder_uid, updated_at desc) where owner = 'founder';
create index maktoub_companion_threads_client_idx on public.maktoub_companion_threads(enrolment_id, updated_at desc) where owner = 'client';

-- Append-only conversation. Assistant turns keep Claude's full content blocks (thinking signatures included)
-- so the conversation can be replayed exactly; the visible text is stored alongside for display.
create table public.maktoub_companion_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.maktoub_companion_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  text text not null check (length(text) <= 60000),
  content jsonb,                           -- assistant only: the API content blocks, unchanged
  model text,
  usage jsonb,
  created_at timestamptz not null default now()
);
create index maktoub_companion_messages_thread_idx on public.maktoub_companion_messages(thread_id, id);

-- A client's acceptance of the companion notice, with the exact text they saw.
create table public.maktoub_companion_consents (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete cascade,
  notice_version text not null,
  notice_sha256 text not null check (notice_sha256 ~ '^[0-9a-f]{64}$'),
  notice_snapshot text not null,
  ip_hash text,
  user_agent text,
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index maktoub_companion_consents_enrolment_idx on public.maktoub_companion_consents(enrolment_id, granted_at desc);

create or replace function public.maktoub_companion_touch() returns trigger language plpgsql set search_path = '' as $$
begin
  update public.maktoub_companion_threads set updated_at = now() where id = new.thread_id;
  return new;
end $$;
create trigger maktoub_companion_messages_touch after insert on public.maktoub_companion_messages
  for each row execute function public.maktoub_companion_touch();

-- Messages are never edited: replaying an edited history would invalidate Claude's earlier reasoning.
create or replace function public.maktoub_companion_messages_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'companion messages are append-only';
end $$;
create trigger maktoub_companion_messages_no_update before update on public.maktoub_companion_messages
  for each row execute function public.maktoub_companion_messages_guard();

alter table public.maktoub_companion_threads enable row level security;
alter table public.maktoub_companion_messages enable row level security;
alter table public.maktoub_companion_consents enable row level security;
revoke all on public.maktoub_companion_threads, public.maktoub_companion_messages, public.maktoub_companion_consents
  from public, anon, authenticated;
revoke all on function public.maktoub_companion_touch(), public.maktoub_companion_messages_guard() from public, anon, authenticated;
