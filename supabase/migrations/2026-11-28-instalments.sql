-- Two-transfer payment option (founder decision, 28 Nov 2026).
-- A tier may carry `instalments`: { first_minor, balance_minor, due_on 'YYYY-MM-DD', due_label }.
-- The client chooses "in full" or "two transfers" when reporting the first transfer.
-- With two transfers, price_minor stays the full fee; the first invoice covers price_minor - balance_minor
-- and the balance gets its own invoice once verified. Introductions begin only after the balance is verified.
alter table public.maktoub_enrolments
  add column payment_plan text check (payment_plan in ('full', 'split')),
  add column balance_minor integer check (balance_minor is null or balance_minor > 0),
  add column balance_due_on date,
  add column balance_reported_at timestamptz,
  add column balance_client_note text,
  add column balance_verified_at timestamptz,
  add column balance_verified_by uuid,
  add column balance_bank_reference text,
  add column balance_received_on date,
  add column balance_invoice_number text;

alter table public.maktoub_enrolments add constraint enrolment_balance_only_split
  check (payment_plan = 'split' or (balance_minor is null and balance_reported_at is null and balance_verified_at is null));
alter table public.maktoub_enrolments add constraint enrolment_balance_after_first
  check (balance_verified_at is null or payment_verified_at is not null);

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
  if new.balance_verified_at is not null and new.balance_invoice_number is null then
    new.balance_invoice_number := case when new.is_test then 'TEST-B' || upper(substr(md5(new.id::text || 'b'), 1, 5))
      else 'MKT-' || to_char(new.balance_verified_at at time zone 'Asia/Riyadh', 'YYYY') || '-' || lpad(nextval('public.maktoub_invoice_seq')::text, 4, '0') end;
    new.balance_received_on := coalesce(new.balance_received_on, (new.balance_verified_at at time zone 'Asia/Riyadh')::date);
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

-- First offered on mm-mohammed, extended tier (SAR 10,000): SAR 5,000 now, SAR 5,000 in January 2027.
update public.maktoub_programmes p
set tiers = (select jsonb_agg(case when t->>'code' = 'extended'
    then t || jsonb_build_object('instalments', jsonb_build_object('first_minor', 500000, 'balance_minor', 500000, 'due_on', '2027-01-01', 'due_label', 'in January 2027, before matchmaking begins'))
    else t end order by ord) from jsonb_array_elements(p.tiers) with ordinality as x(t, ord))
where p.code = 'mm-mohammed';
