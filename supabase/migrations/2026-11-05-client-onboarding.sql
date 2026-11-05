-- Maktoub invitation-only client onboarding (maktoub.app/onboard/?invite=…)
-- Additive only: new tables, a private bucket, new outbox kinds. Existing booking,
-- CRM, Deenaal intake and Telegram behaviour are unchanged.
-- Every table is service-role only (RLS on, no policies, grants revoked); the
-- maktoub-onboard edge function is the only reader/writer.
begin;

-- 1. Singleton settings. Real invites are refused until the founder has confirmed
--    the legal entity, verified the bank details and approved the agreement text.
create table public.maktoub_onboarding_settings (
  id boolean primary key default true check (id),
  price_minor integer not null default 250000 check (price_minor > 0),
  currency text not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  provider_legal_name text,
  provider_registration text,
  bank_account_name text,
  bank_name text,
  bank_iban text check (bank_iban is null or bank_iban ~ '^SA[0-9]{2}[0-9A-Z]{20}$'),
  bank_swift text check (bank_swift is null or bank_swift ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'),
  bank_verified_at timestamptz,
  bank_verified_by uuid,
  agreement_version text not null default 'MKT-FOUNDING-2026-11-v1',
  privacy_version text not null default 'MKT-PRIVACY-2026-11-v1',
  voice_version text not null default 'MKT-VOICE-2026-11-v1',
  agreement_approved_at timestamptz,
  agreement_approved_by uuid,
  invite_valid_days integer not null default 30 check (invite_valid_days between 1 and 120),
  updated_at timestamptz not null default now()
);
insert into public.maktoub_onboarding_settings (id) values (true);

-- 2. Immutable legal texts. {{PROVIDER}}, {{FEE}} are rendered from settings at
--    signing; the exact rendered text and its SHA-256 are stored with each consent.
create table public.maktoub_legal_documents (
  version text primary key,
  kind text not null check (kind in ('agreement','privacy','voice_processing')),
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create function public.maktoub_legal_documents_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'legal documents are immutable; add a new version instead'; end $$;
create trigger maktoub_legal_documents_immutable before update or delete on public.maktoub_legal_documents
  for each row execute function public.maktoub_legal_documents_immutable();

-- 3. One secure record per invited client.
create table public.maktoub_onboarding (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.maktoub_people(id),
  reference_code text not null unique check (reference_code ~ '^MK-[0-9A-Z]{6}$'),
  invite_token_hash text not null unique,
  invite_expires_at timestamptz not null,
  revoked_at timestamptz,
  is_test boolean not null default false,
  invited_name text not null,
  invited_phone text,
  invited_email text,
  price_minor integer not null,
  currency text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_opened_at timestamptz,
  last_seen_at timestamptz,
  -- Step 1: agreement + consents (details in maktoub_onboarding_consents)
  signed_at timestamptz,
  signature_name text,
  agreement_version text,
  agreement_sha256 text,
  -- Step 2: private intake (Deenaal intake fields, adapted)
  intake jsonb not null default '{}'::jsonb,
  intake_saved_at timestamptz,
  intake_submitted_at timestamptz,
  lead_id bigint,
  -- Step 3: voice
  voice_storage_path text,
  voice_mime text,
  voice_duration_seconds integer check (voice_duration_seconds is null or voice_duration_seconds between 1 and 900),
  voice_submitted_at timestamptz,
  -- Step 4: manual bank transfer
  payment_reported_at timestamptz,
  payment_client_note text,
  payment_verified_at timestamptz,
  payment_verified_by uuid,
  payment_bank_reference text,
  -- After onboarding (founder-managed)
  report_due_at timestamptz,
  report_delivered_at timestamptz,
  consultation_completed_at timestamptz,
  readiness_status text not null default 'pending' check (readiness_status in ('pending','approved','not_yet')),
  readiness_decided_at timestamptz,
  readiness_decided_by uuid,
  matchmaking_started_at timestamptz,
  founder_note text,
  constraint onboarding_step_order check (
    (intake_submitted_at is null or signed_at is not null) and
    (voice_submitted_at is null or intake_submitted_at is not null) and
    (payment_reported_at is null or voice_submitted_at is not null) and
    (payment_verified_at is null or signed_at is not null) and
    (matchmaking_started_at is null or readiness_status = 'approved')
  )
);
create index maktoub_onboarding_person_idx on public.maktoub_onboarding(person_id);
create unique index maktoub_onboarding_one_open_per_person on public.maktoub_onboarding(person_id)
  where revoked_at is null and not is_test;

create table public.maktoub_onboarding_consents (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.maktoub_onboarding(id) on delete restrict,
  person_id uuid not null references public.maktoub_people(id),
  kind text not null check (kind in ('agreement','privacy','voice_processing')),
  document_version text not null references public.maktoub_legal_documents(version),
  document_sha256 text not null,
  document_snapshot text not null,
  granted boolean not null,
  signature_name text,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index maktoub_onboarding_consents_onb_idx on public.maktoub_onboarding_consents(onboarding_id);

create table public.maktoub_onboarding_events (
  id bigint generated always as identity primary key,
  onboarding_id uuid not null references public.maktoub_onboarding(id) on delete restrict,
  actor text not null check (actor in ('client','founder','system')),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index maktoub_onboarding_events_onb_idx on public.maktoub_onboarding_events(onboarding_id, created_at);

-- Consent records are append-only; only withdrawal may be recorded afterwards.
-- Synthetic test records may be deleted so tests leave nothing behind. Children use
-- ON DELETE RESTRICT: a cascade would run after the parent row is gone and bypass this guard.
create function public.maktoub_consents_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.maktoub_onboarding o where o.id = old.onboarding_id and not o.is_test) then
      raise exception 'consent records cannot be deleted';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - 'withdrawn_at') <> (to_jsonb(old) - 'withdrawn_at') then
    raise exception 'consent records are append-only';
  end if;
  return new;
end $$;
create trigger maktoub_consents_guard before update or delete on public.maktoub_onboarding_consents
  for each row execute function public.maktoub_consents_guard();

-- updated_at, report clock (7 days from the later of verified payment and complete
-- submission) and founder alerts through the existing outbox. Test records never alert.
create function public.maktoub_onboarding_before() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.payment_verified_at is not null and new.intake_submitted_at is not null
     and new.voice_submitted_at is not null and new.report_due_at is null then
    new.report_due_at := greatest(new.payment_verified_at, new.intake_submitted_at, new.voice_submitted_at) + interval '7 days';
  end if;
  return new;
end $$;
create trigger maktoub_onboarding_before before insert or update on public.maktoub_onboarding
  for each row execute function public.maktoub_onboarding_before();

create function public.maktoub_onboarding_notify() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_test then return new; end if;
  if new.signed_at is not null and old.signed_at is null then
    insert into public.maktoub_notification_outbox(person_id, kind, event_id) values (new.person_id, 'onboarding_signed', new.id::text) on conflict do nothing;
  end if;
  if new.voice_submitted_at is not null and old.voice_submitted_at is null then
    insert into public.maktoub_notification_outbox(person_id, kind, event_id) values (new.person_id, 'onboarding_submitted', new.id::text) on conflict do nothing;
  end if;
  if new.payment_reported_at is not null and old.payment_reported_at is null then
    insert into public.maktoub_notification_outbox(person_id, kind, event_id) values (new.person_id, 'onboarding_payment_reported', new.id::text) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger maktoub_onboarding_notify after update on public.maktoub_onboarding
  for each row execute function public.maktoub_onboarding_notify();

alter table public.maktoub_onboarding_settings enable row level security;
alter table public.maktoub_legal_documents enable row level security;
alter table public.maktoub_onboarding enable row level security;
alter table public.maktoub_onboarding_consents enable row level security;
alter table public.maktoub_onboarding_events enable row level security;
revoke all on public.maktoub_onboarding_settings, public.maktoub_legal_documents, public.maktoub_onboarding,
  public.maktoub_onboarding_consents, public.maktoub_onboarding_events from public, anon, authenticated;
revoke all on function public.maktoub_legal_documents_immutable(), public.maktoub_consents_guard(),
  public.maktoub_onboarding_before(), public.maktoub_onboarding_notify() from public, anon, authenticated;

-- 4. Private recordings bucket: no storage policies, so only the service role can read or write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maktoub-onboarding', 'maktoub-onboarding', false, 26214400,
        array['audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/aac','audio/x-m4a','audio/wav']);

-- 5. New outbox kinds (existing kinds retained).
alter table public.maktoub_notification_outbox drop constraint maktoub_notification_outbox_kind_check;
alter table public.maktoub_notification_outbox add constraint maktoub_notification_outbox_kind_check check (kind in (
  'signup','event_interest','booking_request','booking_approved','booking_declined',
  'onboarding_signed','onboarding_submitted','onboarding_payment_reported'));

commit;
