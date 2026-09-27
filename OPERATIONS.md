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
