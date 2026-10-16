# Maktoub flow audit — 16 October 2026

## Changes applied
- Supabase Site URL and exact allowed redirect: https://maktoub.app/login/.
- Login now explains expired/used links, validates email, prevents simultaneous send clicks, refreshes expired saved sessions, and requests server sign-out.
- Team event labels corrected to 17 October; existing event row retains its stable ID and now records 17 October 15:30 Riyadh.
- Member endpoint escapes email pattern characters, requires matchmaking interest for intake requests and enforces the displayed 30-day maximum.
- Public signup cannot replace an existing person's authorization email.
- Signup/referral forms show server validation messages.
- CRM view uses security_invoker and has no public/anon/authenticated grants. Internal trigger execution privileges revoked from those roles. Service-role access retained.

## Verified
- Production redirect endpoint returns Maktoub login both with and without explicit redirect_to (invalid-token tests, not successful authentication).
- Expired-link explanation visibly renders on deployed login page.
- Local member handler checks pass: missing authorization, literal email matching, past/far-future dates, invalid slot, non-matchmaking access.
- Public member/team requests rejected with 401; incomplete signup rejected with 400.
- Anonymous CRM request denied; advisory scan no longer reports CRM view or trigger findings.
- Database signup/upsert and duplicate path exercised in a rolled-back transaction; zero test records remain.
- Home, login, technology, event and both VIP pages load.
- Both VIP short links resolve to the same open Google Form, dated 17 October; approval acknowledgement is required.
- 134 canonical contacts; no duplicate nonempty emails. Zero intake requests and zero event-contact rows in these canonical tables at audit time. VIP Google Form responses are separate and were not counted here.

## Unresolved / cannot claim end-to-end verification
- Supabase dashboard shows built-in test email service and recommends custom SMTP for production. Production SMTP credentials/provider setup required; not configured in this audit.
- Five signup notifications in maktoub_notification_outbox remain unsent; latest sent record 2 October. External delivery worker/n8n was not verified. No backlog messages sent.
- No real mailbox confirmation/session test or real intake submission performed. No test guest submitted to the VIP form.
- Intake flow records preferred-time requests, not automatic confirmed Calendar/Meet appointments.
- Leaked-password protection is disabled; not changed (project is on Free plan).
- VIP form is predominantly Arabic, including the English invitation's destination.
