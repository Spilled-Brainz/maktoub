-- One active booking per person per kind of session (20 Nov 2026).
-- Before report reviews existed, a person could hold only one pending/accepted booking of any kind, so an
-- old undecided intake request blocked a client from booking her report review. Intake calls and report
-- reviews are now limited separately.
create unique index maktoub_intake_bookings_one_active_person_kind_idx on public.maktoub_intake_bookings (person_id, session_kind)
  where status = any (array['pending', 'accepted', 'rescheduled']);
drop index public.maktoub_intake_bookings_one_active_person_idx;
