-- Applied to production on 2026-10-16. Keep CRM access on the server only.
begin;
alter view public.maktoub_crm_master set (security_invoker=true);
revoke all on public.maktoub_crm_master from public, anon, authenticated;
revoke execute on function public.maktoub_sync_intake_stage() from public, anon, authenticated;
commit;
