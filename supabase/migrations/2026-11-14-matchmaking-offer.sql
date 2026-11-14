-- Private matchmaking offer on the programme engine (founder request, 14 Nov 2026).
-- Two tiers the client chooses between before signing:
--   standard: Private Matchmaking, 6 months, SAR 2,500, voice analysis optional (+ SAR 1,100)
--   premium:  Private Search, 3 months, SAR 5,000, voice analysis included, three dates guaranteed
alter table public.maktoub_programmes add column tiers jsonb not null default '[]'::jsonb;
alter table public.maktoub_enrolments add column tier text, add column duration_days integer check (duration_days is null or duration_days between 7 and 365);

alter table public.maktoub_enrolments drop constraint maktoub_enrolments_voice_addon_status_check;
alter table public.maktoub_enrolments add constraint maktoub_enrolments_voice_addon_status_check
  check (voice_addon_status in ('none','offered','requested','payment_reported','paid','declined','included'));
alter table public.maktoub_enrolments drop constraint enrolment_voice_after_addon;
alter table public.maktoub_enrolments add constraint enrolment_voice_after_addon
  check (voice_storage_path is null or voice_addon_status in ('requested','payment_reported','paid','included'));

-- End date follows the chosen tier's duration when there is one.
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
  if new.payment_verified_at is not null and new.prep_due_at is null then
    new.prep_due_at := new.payment_verified_at + make_interval(days => coalesce(v_prep, 10));
  end if;
  if new.start_date is not null then
    new.end_date := new.start_date + (coalesce(new.duration_days, v_days, 90) - 1) + new.pause_days_total;
  else
    new.end_date := null;
  end if;
  return new;
end $$;

insert into public.maktoub_legal_documents (version, kind, title, body) values
('MM-AGREEMENT-2026-11-v1', 'programme_agreement', 'Private Matchmaking Agreement', $doc$
This Agreement is between {{PROVIDER}} ("Maktoub", "we") and the client named in the signature below ("you"). It applies to Maktoub private matchmaking ("the Service").

1. What the Service is
A private, personalised matchmaking service that begins by understanding you: a voice analysis, an intake covering your mindset and physical habits, and a recommended protocol. Mindset review and support continue along the way.
It is not psychotherapy, medical care, a dating app or an emergency service.

2. Your selected option
{{TIER}}
Fee: {{FEE}}.

3. The two options
- Private Matchmaking: six months of active matchmaking from your agreed start date, with introductions to screened, identity-verified, potentially compatible people as suitable matches are found. Voice analysis is available as an add-on at {{VOICE_FEE}}.
- Private Search: three months of an intensified search, voice analysis included, with three dates guaranteed. A date means a meeting with an introduction you have accepted. If fewer than three dates take place within the three months, the search continues at no extra cost until three have taken place. An accepted date that you cancel or do not attend counts towards the three.

4. Voice analysis
Your recording is analysed by a specialist third-party provider and read by the founder. It is a signal layer that suggests patterns to explore, not a diagnosis or a verdict.

5. Mind and body
Your intake covers mindset, movement, food, sleep and recovery so that we can recommend the protocol that fits you. Mindset review and support are provided at points we agree. A recommended programme or protocol may be offered separately unless it is included in writing.

6. Introductions
Your identity is never disclosed, and no introduction is arranged, without your explicit prior approval. Every introduction is to a person who has been screened and identity-verified.

7. No guarantee of outcome
Compatibility, attraction and commitment depend on two people. Except for the Private Search date guarantee in section 3, no particular result, relationship or marriage is guaranteed.

8. Your commitment
You agree to answer honestly, verify your identity, respond to proposed introductions within a reasonable time, and treat every person introduced to you with respect and discretion.

9. Confidentiality
Your information is confidential, used only to deliver the Service, and handled as described in the consents you sign with this Agreement.

10. Fees, pauses and refunds
Fees, pauses, cancellation and refunds are governed by the Payment, Pause and Refund Terms, which form part of this Agreement.

11. Emergencies
The Service is not monitored continuously. If you are in danger or unwell, contact local emergency services (911 in Saudi Arabia; 999 or 998 in the UAE).

12. General
This Agreement, with the documents signed alongside it, is the entire agreement for the Service. It is governed by the laws of the Kingdom of Saudi Arabia. Nothing in it limits rights that cannot lawfully be excluded.
$doc$);

insert into public.maktoub_programmes (code, name, category, duration_days, prep_days, live_sessions, price_minor, currency, voice_addon_minor, documents, tiers)
values ('matchmaking', 'Private Matchmaking', 'Matchmaking', 180, 10, 3, 250000, 'SAR', 110000,
  jsonb_build_object(
    'programme_agreement', 'MM-AGREEMENT-2026-11-v1',
    'programme_terms', 'RP-TERMS-2026-11-v1',
    'medical_disclaimer', 'RP-MEDICAL-2026-11-v2',
    'health_consent', 'RP-HEALTH-2026-11-v3',
    'digital_consent', 'RP-DIGITAL-2026-11-v1',
    'programme_voice', 'RP-VOICE-2026-11-v1'),
  jsonb_build_array(
    jsonb_build_object('code', 'standard', 'name', 'Private Matchmaking', 'months', 6, 'price_minor', 250000, 'voice_included', false, 'dates', null,
      'summary', 'Six months of active matchmaking. Voice analysis available as an add-on.'),
    jsonb_build_object('code', 'premium', 'name', 'Private Search', 'months', 3, 'price_minor', 500000, 'voice_included', true, 'dates', 3,
      'summary', 'Three months of an intensified search, voice analysis included, three dates guaranteed.')));
