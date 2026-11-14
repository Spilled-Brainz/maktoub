-- Health consent v3: discloses that intake answers are delivered to the founder's Telegram (founder decision, 14 Nov 2026).
-- Only replaces the pointer while the document set is still unapproved; v1/v2 remain immutable.
insert into public.maktoub_legal_documents (version, kind, title, body) values
('RP-HEALTH-2026-11-v3', 'health_consent', 'Sensitive Health Information Consent', $doc$
1. Why we ask
To shape a safe, realistic lifestyle plan we need information about your wellbeing, including your blood test results. Health information is sensitive personal data, so we ask for your separate, explicit consent.

2. What we collect
- Self-reported wellbeing ratings, habits and routines from your intake.
- Injuries or limitations you describe in your own words.
- Blood test results you upload through your portal, for temporary review.
- Whether a professional has cleared you to begin, and any practical, non-diagnostic constraints.

3. Your intake answers
When you submit your intake, your answers are stored in your private programme record and sent privately to the founder's personal Telegram account so they can be reviewed promptly. Telegram is a third-party messaging service with its own privacy terms. These messages are deleted from Telegram when your Programme ends. Blood result files are never sent through Telegram.

4. Blood results: temporary review only
- Uploaded only through your private portal, into a separate, encrypted, access-restricted store.
- Viewed only by the founder and, with your agreement, a qualified professional, through short-lived private links.
- Used only to adapt your lifestyle plan with non-diagnostic recommendations. Never used for marketing, sold, or used to train AI systems.
- Permanently deleted once reviewed, and at the latest 14 days after upload. You can delete a file yourself at any time from your portal.
- After deletion we keep only a short, non-diagnostic note of what your plan must respect, and a record that a file was received, reviewed and deleted.
- Deleted files cannot be restored from our storage. Limited technical metadata may remain in our providers' encrypted system backups and logs for a short period before it expires.

5. Who can see your information
Only the founder and, where strictly necessary, a named person bound by confidentiality. Independent professionals receive only what you authorise.

6. Where it is stored
In access-restricted systems operated by our technology providers, who may store data outside the Kingdom of Saudi Arabia under appropriate safeguards.

7. How long
Blood result files: as in section 4. Other programme information: for the Programme and 12 months after it ends, then deleted or irreversibly anonymised, unless the law requires longer.

8. Your rights
You may access or correct your information, ask for it to be deleted, or withdraw this consent at any time. Withdrawal may mean parts of the Programme can no longer be personalised safely.
$doc$);

update public.maktoub_programmes
   set documents = documents || jsonb_build_object('health_consent', 'RP-HEALTH-2026-11-v3'), updated_at = now()
 where code = 'readiness-90' and documents_approved_at is null;
