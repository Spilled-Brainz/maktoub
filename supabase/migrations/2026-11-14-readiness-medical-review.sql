-- Readiness Programme: temporary, consented review of blood results (founder decision, 14 Nov 2026).
-- Files live only in the private bucket maktoub-medical (service role only), are never sent through Telegram,
-- never enter logs or the intake, and are permanently deleted at the latest 14 days after upload
-- (sooner when the founder marks them reviewed, or when the client deletes them). Deletion is verified by
-- re-listing the storage folder. Only metadata (no content, no file name) is kept for the audit trail.

create table public.maktoub_medical_files (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete restrict,
  label text not null check (length(label) between 1 and 80),
  mime text not null,
  bytes integer not null check (bytes > 0),
  storage_path text,
  uploaded_at timestamptz not null default now(),
  expires_at timestamptz not null,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  reviewed_at timestamptz,
  deleted_at timestamptz,
  deleted_by text check (deleted_by in ('founder','client','expiry')),
  deletion_verified boolean not null default false,
  constraint medical_path_until_deleted check ((deleted_at is null) = (storage_path is not null))
);
create index maktoub_medical_files_enrolment_idx on public.maktoub_medical_files(enrolment_id);
create index maktoub_medical_files_expiry_idx on public.maktoub_medical_files(expires_at) where deleted_at is null;
alter table public.maktoub_medical_files enable row level security;
revoke all on public.maktoub_medical_files from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maktoub-medical', 'maktoub-medical', false, 10485760,
        array['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp'])
on conflict (id) do nothing;

-- Hourly safety-net sweep: calls the function, which deletes expired files and verifies deletion.
insert into public.maktoub_internal_config (key, value) values ('medical_sweep_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;
create extension if not exists pg_cron;
create or replace function public.maktoub_medical_sweep() returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  if not exists (select 1 from public.maktoub_medical_files where deleted_at is null and expires_at <= now()) then return; end if;
  select value into v_secret from public.maktoub_internal_config where key = 'medical_sweep_secret';
  perform net.http_post(
    url := 'https://pmjvpnqmklxxpswwvbmv.supabase.co/functions/v1/maktoub-programme',
    body := '{"sweep":true}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sweep-secret', v_secret),
    timeout_milliseconds := 20000);
end $$;
revoke all on function public.maktoub_medical_sweep() from public, anon, authenticated;
select cron.schedule('maktoub-medical-sweep', '17 * * * *', 'select public.maktoub_medical_sweep()');

-- Documents v2: blood results are now requested, reviewed temporarily, then deleted.
insert into public.maktoub_legal_documents (version, kind, title, body) values
('RP-MEDICAL-2026-11-v2', 'medical_disclaimer', 'Medical and Professional Services Disclaimer', $doc$
1. Maktoub is not a medical provider
Maktoub does not diagnose, treat or prevent any medical or psychological condition, does not prescribe medication, supplements, diets or individual exercise treatment, and does not clinically interpret medical results.

2. Medical check-in and blood results
Before starting structured physical activity, you agree to see a licensed physician of your choice for an initial check-in, and to share your recent blood test results through your private portal. Results are reviewed to shape a safe, realistic lifestyle plan. Any medical interpretation is made by a qualified professional; Maktoub uses only non-diagnostic recommendations to adapt your plan.

3. How to share results
Upload results only through your portal. Never send them by Telegram, WhatsApp, email or any other channel. Uploaded files are deleted as set out in the Sensitive Health Information Consent.

4. Independent professionals
Doctors, trainers, nutritionists and other professionals we may suggest or coordinate with are independent. They are responsible for their own advice and services and contract with you directly.

5. Listen to your body
Stop any activity and seek medical attention if you experience pain, dizziness, chest discomfort, shortness of breath or any other concerning symptom. Tell us about any new injury, condition or change in medication that may affect your plan.

6. Mental wellbeing
The Programme supports reflection and behavioural consistency. It is not a substitute for care from a qualified mental health professional. If you need that care, we will encourage you to seek it and may pause the Programme while you do.
$doc$),
('RP-HEALTH-2026-11-v2', 'health_consent', 'Sensitive Health Information Consent', $doc$
1. Why we ask
To shape a safe, realistic lifestyle plan we need information about your wellbeing, including your blood test results. Health information is sensitive personal data, so we ask for your separate, explicit consent.

2. What we collect
- Self-reported wellbeing ratings, habits and routines from your intake.
- Injuries or limitations you describe in your own words.
- Blood test results you upload through your portal, for temporary review.
- Whether a professional has cleared you to begin, and any practical, non-diagnostic constraints.

3. Blood results: temporary review only
- Uploaded only through your private portal, into a separate, encrypted, access-restricted store.
- Viewed only by the founder and, with your agreement, a qualified professional, through short-lived private links.
- Used only to adapt your lifestyle plan with non-diagnostic recommendations. Never used for marketing, sold, or used to train AI systems.
- Permanently deleted once reviewed, and at the latest 14 days after upload. You can delete a file yourself at any time from your portal.
- After deletion we keep only a short, non-diagnostic note of what your plan must respect, and a record that a file was received, reviewed and deleted.
- Deleted files cannot be restored from our storage. Limited technical metadata may remain in our providers' encrypted system backups and logs for a short period before it expires.

4. Who can see your information
Only the founder and, where strictly necessary, a named person bound by confidentiality. Independent professionals receive only what you authorise.

5. Where it is stored
In access-restricted systems operated by our technology providers, who may store data outside the Kingdom of Saudi Arabia under appropriate safeguards.

6. How long
Blood result files: as in section 3. Other programme information: for the Programme and 12 months after it ends, then deleted or irreversibly anonymised, unless the law requires longer.

7. Your rights
You may access or correct your information, ask for it to be deleted, or withdraw this consent at any time. Withdrawal may mean parts of the Programme can no longer be personalised safely.
$doc$);

update public.maktoub_programmes
   set documents = documents || jsonb_build_object('medical_disclaimer', 'RP-MEDICAL-2026-11-v2', 'health_consent', 'RP-HEALTH-2026-11-v2'),
       updated_at = now()
 where code = 'readiness-90' and documents_approved_at is null;
