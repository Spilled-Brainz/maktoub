begin;
-- Before: bucket public=true; SELECT policy allowed anon/authenticated reads.
-- Existing uploads are retained; insert policy and service-role access are unchanged.
update storage.buckets set public=false where id='voice-notes';
drop policy "Public can read voice notes" on storage.objects;
commit;
-- Recovery of original policy (NOT recommended: restores exposure):
-- create policy "Public can read voice notes" on storage.objects for select to anon,authenticated using (bucket_id='voice-notes');
-- update storage.buckets set public=true where id='voice-notes';
