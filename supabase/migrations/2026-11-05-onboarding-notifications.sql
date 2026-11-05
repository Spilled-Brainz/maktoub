-- Adds onboarding context to the existing Telegram outbox payload.
-- Booking/signup output is byte-for-byte unchanged; three keys are appended
-- (onboarding_ref, onboarding_status, console_url), null for non-onboarding kinds.
-- The n8n "Compose" node has a matching branch for the onboarding_* kinds.
create or replace function public.maktoub_next_notification()
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare o record; p record; b record; ob record; v_token text; v_site text := 'https://maktoub.app';
begin
  select * into o from public.maktoub_notification_outbox where sent_at is null order by created_at limit 1 for update skip locked;
  if not found then return null; end if;
  select full_name, normalized_phone, source, source_detail, interest_matchmaking, interest_social, interest_events into p
    from public.maktoub_people where id = o.person_id;
  if o.kind like 'booking_%' and o.event_id ~ '^[0-9a-f-]{36}$' then
    select * into b from public.maktoub_intake_bookings where id = o.event_id::uuid;
  end if;
  if o.kind like 'onboarding_%' and o.event_id ~ '^[0-9a-f-]{36}$' then
    select id, reference_code, signed_at, intake_submitted_at, voice_submitted_at, payment_reported_at, payment_verified_at
      into ob from public.maktoub_onboarding where id = o.event_id::uuid;
  end if;
  if o.kind = 'booking_request' and b.id is not null and b.status = 'pending' then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    update public.maktoub_intake_bookings set action_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
      action_token_expires_at = b.starts_at where id = b.id;
  end if;
  return jsonb_build_object(
    'outbox_id', o.id, 'kind', o.kind,
    'created_riyadh', to_char(o.created_at at time zone 'Asia/Riyadh', 'Dy DD Mon YYYY, HH24:MI'),
    'name', coalesce(p.full_name, 'Member'), 'phone', p.normalized_phone,
    'source', concat_ws(' / ', p.source, p.source_detail),
    'interests', concat_ws(', ', case when p.interest_matchmaking then 'matchmaking' end, case when p.interest_social then 'social club' end, case when p.interest_events then 'events' end),
    'booking_id', b.id, 'booking_status', b.status, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'meet_url', b.meet_url,
    'booking_phone', coalesce(b.booking_phone_e164, p.normalized_phone),
    'starts_riyadh', to_char(b.starts_at at time zone 'Asia/Riyadh', 'Dy DD Mon YYYY, HH24:MI'),
    'decision_url', case when v_token is not null then v_site || '/book/decision/#id=' || b.id || '&t=' || v_token end)
  || jsonb_build_object(
    'onboarding_ref', ob.reference_code,
    'onboarding_status', case when ob.id is null then null
      when ob.payment_verified_at is not null then 'payment verified'
      when ob.payment_reported_at is not null then 'transfer reported, verify in bank'
      when ob.voice_submitted_at is not null then 'intake and voice submitted, awaiting transfer'
      when ob.intake_submitted_at is not null then 'intake submitted'
      when ob.signed_at is not null then 'agreement signed' else 'invited' end,
    'console_url', case when ob.id is not null then v_site || '/onboard/admin/#' || ob.id end);
end $function$;
