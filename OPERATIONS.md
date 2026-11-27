# Maktoub operating handoff

Updated 27 September 2026.

## Source of truth

- Public website: `main/index.html`, deployed through GitHub Pages to maktoub.app.
- Login and team view: `main/login/index.html`.
- Canonical people: Supabase project `pmjvpnqmklxxpswwvbmv`, `public.maktoub_people`.
- Event operations: `public.maktoub_events` and `public.maktoub_event_contacts`.
- Intake requests: `public.maktoub_intake_bookings`.
- Deployed functions are mirrored under `supabase/functions/`. Avoid editing only a deployed function without updating its repo copy.
- Current event ID: `wellness-connection-1010-2026`; date advertised as 10 October 2026. Start time and venue are not confirmed in the database.

## What exists

- Public signup calls `ingest-maktoub-person`; it deduplicates by normalized phone and records interest flags on the canonical person.
- Explicit event interest also creates one event-contact row per person and event.
- `/login/` provides email link or password sign-in. Founder/team sessions can access `maktoub-ops`; verified member email can access `maktoub-member`.
- Founder view lists canonical people, event contacts, and intake requests. Event staff role is limited to event contacts. Event contacts can be added, searched, and moved through New, Contacted, Invited, Confirmed, Declined, Attended, with notes.
- Members whose verified email matches a canonical person can see their status and request a 30-minute intake slot in Riyadh time, at least 48 hours ahead. Requests are pending; they are not confirmed bookings.
- Database booking settings include founder approval and a Ziina deposit. Automated payment verification, Google Calendar creation, Meet link, approval notifications, and rescheduling remain unconnected.
- Telegram alert code exists in the signup and member booking functions. It sends only if server-side `MAKTOUB_TELEGRAM_BOT_TOKEN` and `MAKTOUB_TELEGRAM_CHAT_ID` are configured. Delivery and retries have not been verified.

## Current data and access

At last check: zero canonical people, zero event contacts, zero intake requests. Historical conference contacts and earlier manual signups have not been imported. The founder admin account is `dee@deenaal.com`; two event colleagues have not been granted access because their identities are not known.

## Launch checks still required

1. Verify the email link redirects to `https://maktoub.app/login/` under Supabase Auth URL configuration and complete a real founder login. Verify a member login with a real signup.
2. Make one controlled public signup, confirm the canonical person and event-contact row, then check duplicate behavior and error messages.
3. Connect the existing Telegram bot securely and verify signup and booking alerts. Do not place bot credentials in public HTML or GitHub.
4. Add the two named event staff accounts with `event_staff` role after their email identities are confirmed. Verify they cannot see unrelated people and bookings.
5. Connect Ziina payment confirmation, founder approval, Google Calendar/Meet creation, and member notifications before advertising an intake request as booked.
6. Backfill prior leads with source labels and deduplication after obtaining the source list.
7. Replace image placeholders with approved authentic photos. The founder portrait has not been identified.
8. Audit the current editable pitch and produce a three-minute version. Existing PDFs contain multiple drafts; no editable master has been designated.

## Tomorrow's conference handoff

Share the website event section for interest registration. Event leads appear in the event queue automatically. Team members can use quick add for a person met in person once their access is granted. The event status and notes live in the database, not a parallel spreadsheet. No one should promise a confirmed event seat or intake slot from an interest submission.

## Booking flow (updated 3 November 2026)

- `/book/` submits directly to the `maktoub-book` edge function (no account needed). It upserts the canonical person by phone, creates a `pending` row in `maktoub_intake_bookings`, and is rate limited per IP and per phone via `maktoub_rate_hit`. A hidden honeypot field silently drops bots.
- The existing booking trigger queues a `booking_request` outbox row. n8n workflow "Maktoub — New signup Telegram alerts" calls `maktoub_next_notification()`, which issues a single-use approval token (only its SHA-256 hash is stored) and returns a `/book/decision/#id=…&t=…` link for the Telegram button.
- `/book/decision/` calls `maktoub-book` (`view`, `approve`, `decline`). `maktoub_decide_booking()` changes status and queues `booking_approved` / `booking_declined` atomically; the token is cleared on use.
- On `booking_approved`, n8n creates the Google Calendar event on dee@deenaal.com with a deterministic id (`mk` + booking id, so retries cannot duplicate) and a Meet link, stores it via `maktoub_record_calendar()`, then sends the founder a one-tap `wa.me` confirmation. No customer message is sent automatically.
- An outbox row is marked sent only after Telegram succeeds.

## Client onboarding (added 5 November 2026)

- One invitation-only journey at `/onboard/?invite=TOKEN`: 1 Welcome & sign, 2 Private intake, 3 Voice, 4 Payment & confirmation. Mobile-first, progress saved server-side; the client resumes with the same link. The token is moved out of the address bar on load and only its SHA-256 is stored.
- Founder console at `/onboard/admin/` (same founder sign-in as `/login/`): readiness checks, invite creation (link shown once, reissue/revoke), full record view, private 10-minute recording links, manual payment verification, report delivered, consultation done, readiness decision, start matchmaking. Not a client portal.
- Backend: edge function `maktoub-onboard` (repo copy in `supabase/functions/maktoub-onboard/`). Tables `maktoub_onboarding`, `maktoub_onboarding_consents` (append-only, exact signed text + SHA-256 per consent), `maktoub_onboarding_events` (audit log), `maktoub_onboarding_settings`, `maktoub_legal_documents` (immutable, versioned). Private bucket `maktoub-onboarding`, no storage policies. All service-role only. Migrations in `supabase/migrations/2026-11-05-*.sql`.
- Real invitations are refused until the founder (1) enters the legal entity name, (2) enters and verifies the corporate bank details, and (3) approves agreement version `MKT-FOUNDING-2026-11-v1`. Editing any bank field clears verification. Changing legal wording means inserting a new document version and pointing settings at it.
- Report due date = later of payment verification and complete submission + 7 days, set automatically. Matchmaking can only be started after readiness approval and verified payment (enforced in the function and by a table constraint).
- Intake (founder decision, 5 Nov 2026): full name, email and date of birth only (18+ enforced server-side). The earlier Deenaal-style questions were removed from the page; the server still accepts their field names. Stored on the onboarding record, not in `leads` (which has a Deenaal `new_lead_notification` webhook).
- Founder alerts: outbox kinds `onboarding_signed`, `onboarding_submitted`, `onboarding_payment_reported`, queued by trigger; test records never queue. The n8n Compose node has an onboarding branch and a generic fallback for unknown kinds (saved 5 Nov as a draft; it must be published in n8n to take effect).
- Agreement: v2 is the founder's Founding Client Agreement (5 Nov 2026) with matching privacy notice and voice consent, plus an optional anonymised-retention consent recorded as granted or declined. The founder countersigns from the console.
- Alert outage, 4–5 Nov 2026: `maktoub_next_notification()` failed with "record b is not assigned yet" for every non-booking alert, so one signup jammed the queue from 4 Nov 02:52 UTC. Fixed 5 Nov by declaring the records as rowtypes; both stuck alerts were then delivered. It was not a Telegram limit.
- Testing: tick "Synthetic test" in the console and use a fictional number +44 7700 900xxx. Test records show a banner, never alert, and can be purged from the console with their recording.
- 8 Nov 2026: n8n stopped running all workflows at 18:58 UTC on 7 Nov (plan execution limit; the 5-minute alert poll plus the 15-minute calendar sync use ~11,000 runs a month), so the first client's onboarding alerts never sent. Onboarding alerts now go straight to Telegram from Supabase (`maktoub-notify`, triggered on outbox insert) and n8n skips them. This needs the edge-function secret `MAKTOUB_TELEGRAM_BOT_TOKEN`. Signup/booking alerts and Calendar creation still depend on n8n.
- Invoices: verifying a payment issues `MKT-YYYY-NNNN` and shows a printable invoice on the client's page. `invoice_billed_to` overrides the name (set to the name on the bank transfer). First invoice: MKT-2026-0001.
- n8n is now event-driven: Supabase calls the n8n webhook `maktoub-outbox-…` when an alert is queued (URL in `maktoub_internal_config`). Polling is a 6-hourly safety net; calendar busy-time sync is hourly (booking slots can be up to an hour behind a new calendar event). Expected ~900 runs a month, inside the 2,500 Starter limit. These n8n changes take effect only once published in n8n.

## The Readiness Programme (added 14 November 2026)

- Maktoub | The Readiness Programme (Get Ready, 90 days, SAR 2,500; optional voice analysis add-on SAR 1,100, paid separately). Six live sessions, up to 10 days' preparation that is separate from the 90 days, and the 90 days count only from the agreed official start date (plus any paused days).
- Client journey and portal: `/ready/?invite=TOKEN` (01 Proposal, 02 Agreement, 03 Transfer, 04 Portal). The token leaves the address bar on load and only its SHA-256 is stored. The same link is his portal: preparation tracker, programme clock, advanced intake, voice recording, published voice report, documents and invoices.
- Founder console: `/ready/admin/` (same founder sign-in). It shows exceptions only: pending transfers, open preparation tasks, overdue preparation and reports to write. It also holds the stage actions, intake view, consents, audit trail and voice report builder (Emowave signals plus founder reading; nothing is visible to the client until published).
- Send on the spot: once connected from the console, send `/ready Anas +9665…` (add `voice` to pre-select the add-on) to the founder bot, and it replies with the private link. `/readytest Anas` creates a synthetic test. `/readiness` lists who needs action. Only the founder chat is accepted, and the webhook is verified with Telegram's secret-token header.
- Backend: edge function `maktoub-programme` (repo copy in `supabase/functions/maktoub-programme/`). Tables `maktoub_programmes` (reusable templates), `maktoub_enrolments`, `maktoub_enrolment_consents` (append-only), `maktoub_enrolment_events` (audit) and `maktoub_voice_reports`, plus the private bucket `maktoub-programme`. All are service-role only. Migrations are in `supabase/migrations/2026-11-14-*.sql`. Bank details and legal name are reused from `maktoub_onboarding_settings`. Invoices share the `MKT-YYYY-NNNN` sequence (test records use `TEST-`).
- Real proposals are refused until the founder approves document set v1 (participation agreement, payment/pause/refund terms, medical disclaimer, health consent, digital/Telegram consent, voice consent). These are drafts for qualified legal review.
- Blood results (founder decision 14 Nov 2026): uploaded only in the portal to the private bucket `maktoub-medical` (register `maktoub_medical_files`, metadata only). The founder views them through 5-minute links and deletes them with "Reviewed: delete now". Any file still there 14 days after upload is deleted automatically, by the function on every load and by the hourly `pg_cron` job `maktoub-medical-sweep`, and each deletion is verified by re-listing storage. Requires health consent v2 (RP-HEALTH-2026-11-v2) and medical disclaimer v2 (RP-MEDICAL-2026-11-v2). Migration `2026-11-14-readiness-medical-review.sql`.
- Founder alerts go straight to the founder's Telegram for: signed, transfer reported (one SAR 3,600 alert when the voice add-on is included), voice add-on requested or reported, recording submitted, and blood results uploaded. On intake submission the full intake answers follow, grouped by section (founder decision 14 Nov 2026, disclosed in health consent v3). Test records alert too, tagged TEST. All of this needs the edge-function secret MAKTOUB_TELEGRAM_BOT_TOKEN; without it, each alert is logged as founder_alert_skipped in the audit trail.
- Not yet built (Phase B onward): daily and weekly Telegram check-ins for clients (separate client-facing bot), weekly protocol and learning library, missed check-in trends, automated summaries.

## Voice report (added 19 November 2026)

- Client report at `/ready/report/`: a full-screen, six-chapter report (Overview, Emotional Mastery, How Your Mind Works, Social Mirror, Negativity, Mind & Body, Life Journey, plus Session notes and Recommendations). It reads the same private link as `/ready/` from the client's device and shows only a published report. The portal card links to it. "Save as PDF" prints every chapter expanded.
- Works for every enrolment whose voice add-on is requested, paid or included (Readiness, Matchmaking, Voice Reading). No database or function change: the report is the existing `maktoub_voice_reports.data` JSON with more fields. Older drafts still render.
- Founder workflow in `/ready/admin/` (client → Voice report): 1 import the EmoWave Full PDF (read in the browser with pdf.js from cdnjs, never uploaded), 2 enter the age and tick the life-journey grid from page 5 (the ticks are drawn, not text), then "Write journey reading", 3 edit each chapter, 4 Preview as client, 5 Publish.
- Import and default readings live in `/ready/report/emowave.js` (parser plus Maktoub reading library: stress bands, senses, brain, seven dynamics, emotions, restrictive patterns, body patterns, journey markers). Edit the library there to change default wording for all future reports.
- EmoWave's speculative clinical lines (autism, dyslexia, allergies and similar) are removed on import, and third-person "his/her" becomes "you". The console flags any clinical or third-person wording still present before publishing.
- `/ready/report/?sample` shows a fictional sample report for prospects. `/ready/report/?preview` is the founder preview; it reads a copy kept in the founder's browser for six hours.
- The negativity "core emotion" is the founder's own reading and is hidden until filled in.

## Report review booking and assessments (added 20 November 2026)

- Session notes open with "Book your report review" on Maktoub's own calendar (see Report review booking below).
- Recommendations list the assessments ticked in the console (both are ticked on import): a six-factor personality test (Mini-IPIP6, Sibley et al. 2011, 24 items, 1 to 7) and the Short Dark Tetrad (SD4, Paulhus et al., 28 items, 1 to 5; Dark Triad plus sadism, shown to clients as "Four identities"). Wording and keys are in `ready/report/assessments.js`; the edge function's scoring key is generated from that file.
- Clients answer one statement per screen; progress saves as they go and resumes on the same link. On submission the function scores each scale (mean, reversed items flipped), stores it in `maktoub_assessments`, and alerts the founder on Telegram. Clients never see scores; the founder sees them on the client record.
- Licences: the 20 IPIP items and the SD4 are public domain. The four Mini-IPIP6 Honesty-Humility items are adapted from Campbell et al. (2004) and the HEXACO-PI-R; commercial permission for those four is not confirmed. The official HEXACO-PI-R and the SD3 need the authors' permission for commercial use.
- Needs the migration `supabase/migrations/2026-11-20-assessments.sql` and a redeploy of `maktoub-programme` before it works live.
- Founding clients (/onboard/) have the same report: stored in `maktoub_onboarding_reports`, built in /onboard/admin/ (Voice report section), opened from the client's onboarding link at /ready/report/?from=onboard. Publishing records the report as delivered.
- Live since 20 Nov 2026: both new tables, `maktoub-onboard` v9 and the website. `maktoub-programme` has NOT been redeployed yet, so programme clients cannot save assessments until it is.
- Razan Alharthi (MK-84P5AP): draft report saved 20 Nov 2026 from the analysis PDF of 17 Nov (the PDF was issued under a different name; her report carries only her own details). Not published.

## Report review booking (added 20 November 2026)

- Clients book their 90-minute report review in Session notes, from the same private link (no form). It uses the existing booking system: `maktoub-book` (`GET ?kind=report_review`, `review_status`, `review_request`), the founder's Google Calendar busy times, the Telegram approve/decline link, and the n8n Calendar event with a Meet link.
- `maktoub_intake_bookings.session_kind` is `intake` or `report_review`; `maktoub_booking_settings.review_minutes` (90) sets the length. Reviews never change the person's intake stage. One active review per person. Migration `2026-11-20-report-review-booking.sql`.
- n8n "Maktoub — New signup Telegram alerts": Compose and Compose confirmation word reviews as a report review (copies in `supabase/n8n/`). Published 20 Nov 2026.
- Once approved, the client's Session notes show the confirmed time and a Join button with the Meet link.

## How we work together (added 28 November 2026)

- Matchmaking proposals (`/ready/`, How it works) and portals show a "How we work together" section when the tier carries a `rhythm` object: `intro`, `human` (You and Deena), `tech` (Lumi and your portal), `timeline` as `[from 'YYYY-MM', to 'YYYY-MM', title, text, key?]`, and `close`. The selected tier's `rhythm` is used first, then any tier's. In the signed portal, the phase covering the current month (Riyadh time) is highlighted as Now. No function or schema change: it is plain data in `maktoub_programmes.tiers`.
- First set on `mm-mohammed`, extended tier: December deprogramming, January to April active matchmaking, membership completes in May.

## Two-transfer payment option (added 28 November 2026)

- A tier may carry `instalments`: `{ first_minor, balance_minor, due_on, due_label }`. The client then chooses "In full" or "Two transfers" on the Transfer step; the choice is fixed when he reports the first transfer (`payment_plan` full or split).
- Split: `price_minor` stays the full fee. Invoice 1 covers the first transfer ("transfer 1 of 2"); the balance has its own invoice once verified (`balance_invoice_number`, same MKT sequence). Columns `balance_*` on `maktoub_enrolments`; migration `2026-11-28-instalments.sql`.
- Portal shows "Your second transfer" with bank details and an "I have transferred" button. Founder alert on report, with a Verify button on Telegram (callback `b:`/`bb:`); the console shows "Verify 2nd transfer", or "2nd transfer due" once the due date passes; `/readiness` flags it too.
- Agreement: `{{FEE}}` spells out both options and that introductions begin once the second transfer is received. mm-mohammed now uses `MM-AGREEMENT-MA-2026-11-v9` (v8 with clause 9 updated for two transfers).
- Not enforced by the system: the console does not block activation before the balance is paid. Introductions waiting for the second transfer is a founder rule.
- First set on mm-mohammed, extended tier: SAR 5,000 after signing, SAR 5,000 due 1 January 2027. Paying in full is pre-selected and shown as the recommended card; two transfers is a quieter secondary choice.
- 28 Nov 2026: mm-mohammed now offers only the extended option (SAR 10,000); the standard tier's custom proposal content was merged into it, his enrolment moved to extended, and the agreement is `MM-AGREEMENT-MA-2026-11-v10` (v9 with the standard option removed).
- `maktoub-programme` v8 deployed 28 Nov 2026 (also ships the assessments code that was waiting for a redeploy).
