-- Voice reports and psychometric assessments for both client journeys (founder decision, 20 Nov 2026).
--   Programme clients (/ready/)      → maktoub_voice_reports (existing) and maktoub_assessments.enrolment_id
--   Founding clients (/onboard/)     → maktoub_onboarding_reports (new) and maktoub_assessments.onboarding_id
-- The founder recommends assessments in the published report (data.notes.tests). The client answers them in the
-- report's Recommendations tab; progress saves as they go. Scores are computed by the edge function on
-- submission and shown to the founder only. Service role only, like every other client table.

create table public.maktoub_onboarding_reports (
  onboarding_id uuid primary key references public.maktoub_onboarding(id) on delete restrict,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  published_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.maktoub_onboarding_reports enable row level security;
revoke all on public.maktoub_onboarding_reports from public, anon, authenticated;

create table public.maktoub_assessments (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid references public.maktoub_enrolments(id) on delete restrict,
  onboarding_id uuid references public.maktoub_onboarding(id) on delete restrict,
  kind text not null check (kind in ('six_factor', 'dark_triad')),
  instrument text not null,
  answers jsonb not null default '[]'::jsonb,
  scores jsonb,
  started_at timestamptz not null default now(),
  saved_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (enrolment_id, kind),
  unique (onboarding_id, kind),
  constraint assessment_one_client check (num_nonnulls(enrolment_id, onboarding_id) = 1),
  constraint assessment_scores_when_complete check ((completed_at is null) = (scores is null))
);
create index maktoub_assessments_enrolment_idx on public.maktoub_assessments(enrolment_id);
create index maktoub_assessments_onboarding_idx on public.maktoub_assessments(onboarding_id);
alter table public.maktoub_assessments enable row level security;
revoke all on public.maktoub_assessments from public, anon, authenticated;
