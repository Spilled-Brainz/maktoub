-- Maktoub | The Readiness Programme (Get Ready · 90 days)
-- Additive only: new tables, one widened check constraint on maktoub_legal_documents.kind.
-- Nothing in the existing onboarding, booking, people or outbox tables is altered.
-- All new tables: RLS on, no policies, privileges revoked → service role only (edge function maktoub-programme).

-- 1. Programme templates (reusable for future clients) ------------------------------------------
create table public.maktoub_programmes (
  code text primary key check (code ~ '^[a-z0-9-]{3,40}$'),
  name text not null,
  category text not null,
  duration_days integer not null check (duration_days between 7 and 365),
  prep_days integer not null default 10 check (prep_days between 0 and 30),
  live_sessions integer not null check (live_sessions between 0 and 52),
  price_minor integer not null check (price_minor > 0),
  currency text not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  voice_addon_minor integer check (voice_addon_minor is null or voice_addon_minor > 0),
  -- Legal document versions shown and signed for this programme (keys = document kind).
  documents jsonb not null default '{}'::jsonb,
  documents_approved_at timestamptz,
  documents_approved_by uuid,
  invite_valid_days integer not null default 21 check (invite_valid_days between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Legal texts: widen the kinds on the existing immutable, versioned table --------------------
alter table public.maktoub_legal_documents drop constraint maktoub_legal_documents_kind_check;
alter table public.maktoub_legal_documents add constraint maktoub_legal_documents_kind_check check (kind in (
  'agreement','privacy','voice_processing','voice_research',
  'programme_agreement','programme_terms','health_consent','digital_consent','medical_disclaimer','programme_voice'));

-- 3. One enrolment per client per programme -----------------------------------------------------
create table public.maktoub_enrolments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.maktoub_people(id),
  programme_code text not null references public.maktoub_programmes(code),
  reference_code text not null unique check (reference_code ~ '^RP-[0-9A-Z]{6}$'),
  invite_token_hash text not null unique check (invite_token_hash ~ '^[0-9a-f]{64}$'),
  invite_expires_at timestamptz not null,
  revoked_at timestamptz,
  is_test boolean not null default false,
  invited_name text not null,
  invited_phone text not null,
  addressed_as text not null default 'man' check (addressed_as in ('man','woman')),
  timezone text not null default 'Asia/Riyadh',
  -- price snapshot at invitation
  price_minor integer not null check (price_minor > 0),
  currency text not null,
  -- lifecycle
  stage text not null default 'invited' check (stage in (
    'invited','signed','payment_reported','payment_verified',
    'meeting_pending','meeting_completed','medical_pending','baseline','protocol_preparing',
    'bot_configuration','portal_ready','start_confirmed','active','paused','completed','cancelled')),
  first_opened_at timestamptz,
  last_seen_at timestamptz,
  signed_at timestamptz,
  signature_name text,
  -- programme fee (bank transfer, verified by hand)
  payment_reported_at timestamptz,
  payment_client_note text,
  payment_verified_at timestamptz,
  payment_verified_by uuid,
  payment_bank_reference text,
  payment_received_on date,
  invoice_number text unique,
  invoice_issued_at timestamptz,
  invoice_billed_to text,
  -- voice analysis add-on (optional upsell, paid separately)
  voice_addon_status text not null default 'none' check (voice_addon_status in ('none','offered','requested','payment_reported','paid','declined')),
  voice_addon_minor integer,
  voice_addon_requested_at timestamptz,
  voice_addon_reported_at timestamptz,
  voice_addon_verified_at timestamptz,
  voice_addon_invoice_number text unique,
  voice_storage_path text,
  voice_mime text,
  voice_duration_seconds integer check (voice_duration_seconds is null or voice_duration_seconds between 1 and 900),
  voice_submitted_at timestamptz,
  -- intake (advanced, completed in the portal after payment)
  intake jsonb not null default '{}'::jsonb,
  intake_saved_at timestamptz,
  intake_submitted_at timestamptz,
  -- preparation (≤ prep_days after payment verified + intake) and programme dates
  prep_due_at timestamptz,
  planning_meeting_at timestamptz,
  planning_meeting_completed_at timestamptz,
  -- medical coordination: status and non-diagnostic constraints only. No reports, results or records here.
  medical_status text not null default 'not_started' check (medical_status in ('not_started','pending','cleared','cleared_with_constraints','not_required')),
  medical_constraints text check (medical_constraints is null or length(medical_constraints) <= 600),
  start_date date,
  end_date date,
  paused_at timestamptz,
  pause_days_total integer not null default 0 check (pause_days_total >= 0),
  completed_at timestamptz,
  founder_note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint enrolment_paid_before_active check (stage not in ('active','completed') or (payment_verified_at is not null and start_date is not null)),
  constraint enrolment_signed_before_payment check (payment_reported_at is null or signed_at is not null),
  constraint enrolment_voice_after_addon check (voice_storage_path is null or voice_addon_status in ('requested','payment_reported','paid'))
);
create unique index maktoub_enrolments_one_open on public.maktoub_enrolments(person_id, programme_code)
  where revoked_at is null and not is_test and stage not in ('completed','cancelled');
create index maktoub_enrolments_stage_idx on public.maktoub_enrolments(stage);

create table public.maktoub_enrolment_consents (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete restrict,
  person_id uuid not null references public.maktoub_people(id),
  kind text not null,
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
create index maktoub_enrolment_consents_idx on public.maktoub_enrolment_consents(enrolment_id);

create table public.maktoub_enrolment_events (
  id bigint generated always as identity primary key,
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete restrict,
  actor text not null check (actor in ('client','founder','system','telegram')),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index maktoub_enrolment_events_idx on public.maktoub_enrolment_events(enrolment_id, created_at);

-- 4. Voice reports (Emowave signals + founder reading). Visible to the client only once published.
create table public.maktoub_voice_reports (
  enrolment_id uuid primary key references public.maktoub_enrolments(id) on delete restrict,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  published_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- 5. Triggers: timestamps, invoices (shared MKT sequence), preparation window, end date ---------
create or replace function public.maktoub_enrolments_before() returns trigger language plpgsql set search_path = '' as $$
declare v_prep integer; v_days integer;
begin
  new.updated_at := now();
  select prep_days, duration_days into v_prep, v_days from public.maktoub_programmes where code = new.programme_code;
  if new.payment_verified_at is not null and new.invoice_number is null then
    new.invoice_number := case when new.is_test then 'TEST-' || upper(substr(md5(new.id::text), 1, 6))
      else 'MKT-' || to_char(new.payment_verified_at at time zone 'Asia/Riyadh', 'YYYY') || '-' || lpad(nextval('public.maktoub_invoice_seq')::text, 4, '0') end;
    new.invoice_issued_at := new.payment_verified_at;
    new.payment_received_on := coalesce(new.payment_received_on, (new.payment_verified_at at time zone 'Asia/Riyadh')::date);
  end if;
  if new.voice_addon_verified_at is not null and new.voice_addon_invoice_number is null then
    new.voice_addon_invoice_number := case when new.is_test then 'TEST-V' || upper(substr(md5(new.id::text || 'v'), 1, 5))
      else 'MKT-' || to_char(new.voice_addon_verified_at at time zone 'Asia/Riyadh', 'YYYY') || '-' || lpad(nextval('public.maktoub_invoice_seq')::text, 4, '0') end;
  end if;
  -- The preparation window opens when payment is verified; it is separate from the 90 days.
  if new.payment_verified_at is not null and new.prep_due_at is null then
    new.prep_due_at := new.payment_verified_at + make_interval(days => coalesce(v_prep, 10));
  end if;
  -- The 90-day countdown runs only from the agreed official start date (plus any paused days).
  if new.start_date is not null then
    new.end_date := new.start_date + (coalesce(v_days, 90) - 1) + new.pause_days_total;
  else
    new.end_date := null;
  end if;
  return new;
end $$;
create trigger maktoub_enrolments_before before insert or update on public.maktoub_enrolments
  for each row execute function public.maktoub_enrolments_before();

-- Consents are append-only (withdrawal may be recorded); test enrolments may be purged.
create or replace function public.maktoub_enrolment_consents_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.maktoub_enrolments e where e.id = old.enrolment_id and e.is_test) then return old; end if;
    raise exception 'consent records are append-only';
  end if;
  if new.withdrawn_at is not null and old.withdrawn_at is null
     and (new.kind, new.document_version, new.document_sha256, new.document_snapshot, new.granted) is not distinct from
         (old.kind, old.document_version, old.document_sha256, old.document_snapshot, old.granted) then return new; end if;
  raise exception 'consent records are append-only';
end $$;
create trigger maktoub_enrolment_consents_guard before update or delete on public.maktoub_enrolment_consents
  for each row execute function public.maktoub_enrolment_consents_guard();

-- 6. Lock down --------------------------------------------------------------------------------
alter table public.maktoub_programmes enable row level security;
alter table public.maktoub_enrolments enable row level security;
alter table public.maktoub_enrolment_consents enable row level security;
alter table public.maktoub_enrolment_events enable row level security;
alter table public.maktoub_voice_reports enable row level security;
revoke all on public.maktoub_programmes, public.maktoub_enrolments, public.maktoub_enrolment_consents,
  public.maktoub_enrolment_events, public.maktoub_voice_reports from public, anon, authenticated;
revoke all on function public.maktoub_enrolments_before(), public.maktoub_enrolment_consents_guard() from public, anon, authenticated;

-- Private bucket for programme voice recordings (no storage policies → service role only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maktoub-programme', 'maktoub-programme', false, 26214400,
        array['audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/aac','audio/x-m4a','audio/wav'])
on conflict (id) do nothing;

-- 7. The first programme. Documents are drafts until the founder approves them in /ready/admin/.
insert into public.maktoub_programmes (code, name, category, duration_days, prep_days, live_sessions, price_minor, currency, voice_addon_minor, documents)
values ('readiness-90', 'The Readiness Programme', 'Get Ready', 90, 10, 6, 250000, 'SAR', 110000,
  jsonb_build_object(
    'programme_agreement', 'RP-AGREEMENT-2026-11-v1',
    'programme_terms', 'RP-TERMS-2026-11-v1',
    'medical_disclaimer', 'RP-MEDICAL-2026-11-v1',
    'health_consent', 'RP-HEALTH-2026-11-v1',
    'digital_consent', 'RP-DIGITAL-2026-11-v1',
    'programme_voice', 'RP-VOICE-2026-11-v1'));
