-- Report review sessions on the existing Maktoub booking calendar (founder decision, 20 Nov 2026).
-- Same slots, Google Calendar busy times, Telegram approval, Calendar event and Meet link as intake calls,
-- but booked from the client's report with their private link, 90 minutes long, and never touching the
-- person's intake stage in the CRM.

alter table public.maktoub_intake_bookings
  add column session_kind text not null default 'intake' check (session_kind in ('intake', 'report_review'));
alter table public.maktoub_booking_settings
  add column review_minutes integer not null default 90 check (review_minutes between 30 and 180);

-- Duration depends on the kind of session; everything else is unchanged.
create or replace function public.validate_maktoub_intake_booking()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_settings public.maktoub_booking_settings%rowtype;
  v_minutes integer;
begin
  select * into v_settings from public.maktoub_booking_settings where id = true;
  v_minutes := case when new.session_kind = 'report_review' then v_settings.review_minutes else v_settings.session_minutes end;

  if new.ends_at is null then
    new.ends_at := new.starts_at + make_interval(mins => v_minutes);
  end if;
  if new.ends_at <> new.starts_at + make_interval(mins => v_minutes) then
    raise exception 'These sessions must be % minutes', v_minutes;
  end if;
  if (TG_OP = 'INSERT' OR new.starts_at IS DISTINCT FROM old.starts_at) AND new.starts_at < now() + make_interval(hours => v_settings.minimum_notice_hours) then
    raise exception 'Bookings require at least % hours notice', v_settings.minimum_notice_hours;
  end if;
  if (TG_OP = 'INSERT' OR new.starts_at IS DISTINCT FROM old.starts_at) AND new.starts_at > now() + make_interval(days => v_settings.max_days_ahead) then
    raise exception 'Booking is beyond the allowed booking horizon';
  end if;
  if new.status = 'awaiting_payment' and new.payment_hold_expires_at is null then
    new.payment_hold_expires_at := now() + interval '20 minutes';
  end if;
  if new.status in ('awaiting_payment','pending','accepted','rescheduled') and exists (
    select 1 from public.maktoub_intake_bookings b
    where b.id <> coalesce(new.id, gen_random_uuid())
      and b.status in ('awaiting_payment','pending','accepted','rescheduled')
      and not (b.status = 'awaiting_payment' and b.payment_hold_expires_at <= now())
      and b.starts_at < new.ends_at + make_interval(mins => v_settings.buffer_minutes)
      and b.ends_at + make_interval(mins => v_settings.buffer_minutes) > new.starts_at
  ) then
    raise exception 'Requested slot conflicts with another booking or its buffer';
  end if;
  return new;
end;
$function$;

-- Report reviews never change the person's intake stage.
create or replace function public.maktoub_sync_intake_stage()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.session_kind <> 'intake' then return new; end if;
  if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    update public.maktoub_people
       set stage = case when stage in ('new', 'contacted') then 'waiting_to_book' else stage end,
           intake_status = case when intake_status = 'not_started' then 'waiting_to_book' else intake_status end
     where id = new.person_id;
  elsif new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    update public.maktoub_people
       set stage = case when stage in ('new', 'contacted', 'waiting_to_book') then 'intake_booked' else stage end,
           intake_status = case when intake_status in ('not_started', 'waiting_to_book') then 'booked' else intake_status end
     where id = new.person_id;
  end if;
  return new;
end;
$function$;

create or replace function public.sync_maktoub_person_from_booking()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.session_kind <> 'intake' then return new; end if;
  if new.status = 'awaiting_payment' then
    update public.maktoub_people
    set stage = 'waiting_to_book', intake_status = 'waiting_to_book', last_contact_at = now(),
      next_action = 'Complete intake deposit', next_action_at = new.payment_hold_expires_at
    where id = new.person_id and intake_status <> 'completed';
  elsif new.status = 'pending' then
    update public.maktoub_people
    set stage = 'waiting_to_book', intake_status = 'waiting_to_book', last_contact_at = now(),
      next_action = 'Review intake booking request', next_action_at = now()
    where id = new.person_id and intake_status <> 'completed';
  elsif new.status in ('accepted','rescheduled') then
    update public.maktoub_people
    set stage = 'intake_booked', intake_status = 'booked', intake_booked_at = new.starts_at, last_contact_at = now(),
      next_action = 'Complete private intake', next_action_at = new.starts_at
    where id = new.person_id;
  elsif new.status = 'completed' then
    update public.maktoub_people
    set stage = 'intake_completed', intake_status = 'completed', intake_completed_at = coalesce(intake_completed_at, now()),
      last_contact_at = now(), next_action = null, next_action_at = null
    where id = new.person_id;
  elsif new.status in ('rejected','cancelled') then
    update public.maktoub_people
    set stage = 'waiting_to_book', intake_status = 'waiting_to_book', intake_booked_at = null, last_contact_at = now(),
      next_action = case when new.status = 'rejected' then 'Choose another intake time' else 'Rebook private intake' end,
      next_action_at = now()
    where id = new.person_id and intake_status <> 'completed';
  end if;
  return new;
end;
$function$;

-- n8n needs to know which kind of session it is announcing and putting in the calendar.
create or replace function public.maktoub_next_notification()
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare o record; p record; b public.maktoub_intake_bookings%rowtype; ob public.maktoub_onboarding%rowtype; v_token text; v_site text := 'https://maktoub.app';
begin
  select * into o from public.maktoub_notification_outbox where sent_at is null order by created_at limit 1 for update skip locked;
  if not found then return null; end if;
  select full_name, normalized_phone, source, source_detail, interest_matchmaking, interest_social, interest_events into p
    from public.maktoub_people where id = o.person_id;
  if o.kind like 'booking_%' and o.event_id ~ '^[0-9a-f-]{36}$' then
    select * into b from public.maktoub_intake_bookings where id = o.event_id::uuid;
  end if;
  if o.kind like 'onboarding_%' and o.event_id ~ '^[0-9a-f-]{36}$' then
    select * into ob from public.maktoub_onboarding where id = o.event_id::uuid;
  end if;
  if o.kind = 'booking_request' and b.id is not null and b.status = 'pending' then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    update public.maktoub_intake_bookings set action_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
      action_token_expires_at = b.starts_at where id = b.id;
  end if;
  return jsonb_build_object(
    'outbox_id', o.id, 'kind', o.kind,
    'created_riyadh', to_char(o.created_at at time zone 'Asia/Riyadh', 'Dy DD Mon YYYY, HH24:MI'),
    'name', coalesce(ob.intake->>'full_name', p.full_name, 'Member'), 'phone', p.normalized_phone,
    'source', concat_ws(' / ', p.source, p.source_detail),
    'interests', concat_ws(', ', case when p.interest_matchmaking then 'matchmaking' end, case when p.interest_social then 'social club' end, case when p.interest_events then 'events' end),
    'booking_id', b.id, 'booking_status', b.status, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'meet_url', b.meet_url,
    'session_kind', coalesce(b.session_kind, 'intake'),
    'booking_phone', coalesce(b.booking_phone_e164, p.normalized_phone),
    'starts_riyadh', to_char(b.starts_at at time zone 'Asia/Riyadh', 'Dy DD Mon YYYY, HH24:MI'),
    'decision_url', case when v_token is not null then v_site || '/book/decision/#id=' || b.id || '&t=' || v_token end)
  || jsonb_build_object(
    'onboarding_ref', ob.reference_code,
    'onboarding_status', case when ob.id is null then null
      when ob.payment_verified_at is not null then 'payment verified'
      when ob.payment_reported_at is not null then 'transfer reported, verify in bank'
      when ob.voice_submitted_at is not null then 'details and voice submitted, awaiting transfer'
      when ob.intake_submitted_at is not null then 'details submitted'
      when ob.signed_at is not null then 'agreement signed' else 'invited' end,
    'console_url', case when ob.id is not null then v_site || '/onboard/admin/#' || ob.id end,
    'voice_url', case when o.kind = 'onboarding_submitted' and ob.voice_share_expires_at > now() then ob.voice_share_url end,
    'voice_seconds', case when o.kind = 'onboarding_submitted' then ob.voice_duration_seconds end);
end $function$;
