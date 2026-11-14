-- Programme renamed: Upgrade: Mental and Physical Bootcamp (founder decision, 14 Nov 2026).
-- Agreement v2 carries the new name and phase names; v1 stays immutable. Internal code remains readiness-90.
insert into public.maktoub_legal_documents (version, kind, title, body)
select 'RP-AGREEMENT-2026-11-v2', kind, 'Upgrade Participation Agreement',
  replace(replace(replace(replace(body,
    'Maktoub | The Readiness Programme ("the Programme")', 'Upgrade: Mental and Physical Bootcamp, a Maktoub programme ("the Programme")'),
    'Month 1, Understand and Reset:', 'Month 1, Assess and Design:'),
    'Month 2, Build and Strengthen:', 'Month 2, Build and Accelerate:'),
    'You receive an interim habit plan during this time.', 'Your personalised protocol is delivered approximately 10 days after payment. Initial movement and nutrition guidance may begin earlier, where appropriate.')
from public.maktoub_legal_documents where version = 'RP-AGREEMENT-2026-11-v1';

update public.maktoub_programmes
   set name = 'Upgrade: Mental and Physical Bootcamp', category = 'Upgrade',
       documents = documents || jsonb_build_object('programme_agreement', 'RP-AGREEMENT-2026-11-v2'), updated_at = now()
 where code = 'readiness-90' and documents_approved_at is null;
