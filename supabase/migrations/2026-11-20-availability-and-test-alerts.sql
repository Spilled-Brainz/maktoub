-- 1. Weekly availability in the founder's own time zone (founder decision, 20 Nov 2026).
--    When weekly_hours is set, maktoub-book offers slots only inside these windows (intro calls and report
--    reviews alike); when it is null, the old daily Riyadh window applies. Windows are local "HH:MM" times;
--    an end past 24:00 runs into the next morning. Days are 0 = Sunday … 6 = Saturday.
alter table public.maktoub_booking_settings add column weekly_hours jsonb;
update public.maktoub_booking_settings set weekly_hours = jsonb_build_object(
  'timezone', 'Asia/Bangkok', 'utc_offset_minutes', 420, 'from', '2026-11-24', 'step_minutes', 30,
  'days', jsonb_build_object(
    '2', jsonb_build_array(jsonb_build_array('13:00', '15:00'), jsonb_build_array('22:00', '25:00')),
    '3', jsonb_build_array(jsonb_build_array('13:00', '15:00'), jsonb_build_array('22:00', '25:00')),
    '4', jsonb_build_array(jsonb_build_array('13:00', '15:00'), jsonb_build_array('22:00', '25:00'))))
where id = true;

-- 2. Assessments: earlier attempts are kept when the founder lets a client redo a test.
alter table public.maktoub_assessments add column history jsonb not null default '[]'::jsonb;

-- 3. Founder alert when a founding client completes a test (sent straight to Telegram by maktoub-notify).
alter table public.maktoub_notification_outbox drop constraint maktoub_notification_outbox_kind_check;
alter table public.maktoub_notification_outbox add constraint maktoub_notification_outbox_kind_check check (kind = any (array[
  'signup', 'event_interest', 'booking_request', 'booking_approved', 'booking_declined',
  'onboarding_signed', 'onboarding_submitted', 'onboarding_payment_reported',
  'onboarding_test_six_factor', 'onboarding_test_dark_triad']));
