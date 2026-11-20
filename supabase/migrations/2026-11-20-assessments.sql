-- Psychometric assessments taken inside the client portal (founder decision, 20 Nov 2026).
-- The founder recommends them in the published voice report (recommendations.tests). The client answers in
-- the report's Recommendations tab; progress is saved as they go and resumes on the same private link.
-- Scores are computed by the edge function maktoub-programme on submission and shown to the founder only.
-- Service role only, like every other programme table.

create table public.maktoub_assessments (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.maktoub_enrolments(id) on delete restrict,
  kind text not null check (kind in ('six_factor', 'dark_triad')),
  instrument text not null,
  answers jsonb not null default '[]'::jsonb,
  scores jsonb,
  started_at timestamptz not null default now(),
  saved_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (enrolment_id, kind),
  constraint assessment_scores_when_complete check ((completed_at is null) = (scores is null))
);
create index maktoub_assessments_enrolment_idx on public.maktoub_assessments(enrolment_id);
alter table public.maktoub_assessments enable row level security;
revoke all on public.maktoub_assessments from public, anon, authenticated;
