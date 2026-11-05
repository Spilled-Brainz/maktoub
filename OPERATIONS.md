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
- Intake reuses the deenaal.com/intake questions and field names (adapted, plus matchmaking essentials) but is stored on the onboarding record, not in `leads`: `leads` has a `new_lead_notification` webhook that belongs to the Deenaal flow.
- Founder alerts: outbox kinds `onboarding_signed`, `onboarding_submitted`, `onboarding_payment_reported`, queued by trigger; test records never queue. The n8n Compose node needs an onboarding branch before the first real invite (see below).
- Testing: tick "Synthetic test" in the console and use a fictional number +44 7700 900xxx. Test records show a banner, never alert, and can be purged from the console with their recording.
