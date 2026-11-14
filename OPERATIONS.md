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
