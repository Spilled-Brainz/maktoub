begin;
alter table public.maktoub_notification_outbox drop constraint maktoub_notification_outbox_kind_check;
alter table public.maktoub_notification_outbox add constraint maktoub_notification_outbox_kind_check check (kind in ('signup','event_interest','booking_request'));
create unique index maktoub_intake_bookings_one_active_person_idx on public.maktoub_intake_bookings(person_id) where status in ('pending','accepted','rescheduled');
create function public.queue_maktoub_booking_notification() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.status in ('awaiting_payment','pending') then
  insert into public.maktoub_notification_outbox(person_id,kind,event_id)
  values(new.person_id,'booking_request',new.id::text)
  on conflict(person_id,kind,event_id) do nothing;
 end if;
 return new;
end;
$$;
revoke all on function public.queue_maktoub_booking_notification() from public,anon,authenticated;
grant execute on function public.queue_maktoub_booking_notification() to service_role;
create trigger queue_maktoub_booking_notification after insert on public.maktoub_intake_bookings for each row execute function public.queue_maktoub_booking_notification();
commit;

/* ROLLBACK
-- Pause notification processing before rollback. Preserve queued booking alerts for manual handling.
begin;
drop trigger if exists queue_maktoub_booking_notification on public.maktoub_intake_bookings;
drop function if exists public.queue_maktoub_booking_notification();
drop index if exists public.maktoub_intake_bookings_one_active_person_idx;
-- Keep the expanded kind constraint so existing booking alerts are retained.
commit;
-- Edge rollback: redeploy maktoub-member from backup/pre-reliability-2026-10-28.
-- n8n rollback: inactive BACKUP 2026-10-28 — Signup alerts before reliability repair.
*/
