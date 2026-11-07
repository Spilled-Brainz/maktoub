-- Invoices for verified onboarding payments (applied 8 Nov 2026, Riyadh).
alter table public.maktoub_onboarding
  add column invoice_number text unique,
  add column invoice_issued_at timestamptz,
  add column payment_received_on date;
create sequence public.maktoub_invoice_seq start 1;
revoke all on sequence public.maktoub_invoice_seq from public, anon, authenticated;

-- Invoice number is issued once, when payment is verified. Real records: MKT-YYYY-NNNN; test records: TEST-xxxxxx.
create or replace function public.maktoub_onboarding_before() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.payment_verified_at is not null and new.intake_submitted_at is not null
     and new.voice_submitted_at is not null and new.report_due_at is null then
    new.report_due_at := greatest(new.payment_verified_at, new.intake_submitted_at, new.voice_submitted_at) + interval '7 days';
  end if;
  if new.payment_verified_at is not null and new.invoice_number is null then
    new.invoice_number := case when new.is_test then 'TEST-' || upper(substr(md5(new.id::text), 1, 6))
      else 'MKT-' || to_char(new.payment_verified_at at time zone 'Asia/Riyadh', 'YYYY') || '-' || lpad(nextval('public.maktoub_invoice_seq')::text, 4, '0') end;
    new.invoice_issued_at := new.payment_verified_at;
    new.payment_received_on := coalesce(new.payment_received_on, (new.payment_verified_at at time zone 'Asia/Riyadh')::date);
  end if;
  return new;
end $$;
-- Data step applied at the same time: the first client's payment was verified from the founder's SNB alert
-- (SAR 2,500, 08/11/2026 00:29) and received invoice MKT-2026-0001.
