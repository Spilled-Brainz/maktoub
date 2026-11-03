// Public booking endpoint for maktoub.app/book/ and the founder decision page.
// GET            -> available slots (no personal data)
// POST request   -> upsert canonical person + pending booking (rate limited, honeypot)
// POST view|approve|decline -> founder actions gated by a single-use hashed token issued by n8n
import { createClient } from 'npm:@supabase/supabase-js@2'
import { parsePhoneNumberFromString } from 'npm:libphonenumber-js@1.11.20'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const ORIGINS = new Set(['https://maktoub.app', 'https://www.maktoub.app'])
const ACTIVE = ['awaiting_payment', 'pending', 'accepted', 'rescheduled']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const headers = (o: string | null): HeadersInit => ({
  'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'Cache-Control': 'no-store',
  ...(o && ORIGINS.has(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' } : {}),
})
const json = (b: unknown, s: number, o: string | null) => new Response(JSON.stringify(b), { status: s, headers: headers(o) })
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('')
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
const limited = async (key: string, max: number, secs: number) => {
  const { data, error } = await db.rpc('maktoub_rate_hit', { p_key: await sha256(key), p_max: max, p_window_seconds: secs })
  if (error) { console.error('rate limit check failed', error); return false } // fail open: never block real applicants on a counter fault
  return data === false
}

async function settings() {
  const { data, error } = await db.from('maktoub_booking_settings').select('*').eq('id', true).single()
  if (error || !data) throw new Error('settings unavailable')
  return data
}

// Hourly slots inside the configured Riyadh window (UTC+3, no DST), minus anything that conflicts incl. buffer.
async function availableSlots() {
  const s = await settings()
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  const startMin = toMin(s.booking_window_start), endMin = toMin(s.booking_window_end)
  const sessionMs = s.session_minutes * 60000, bufferMs = s.buffer_minutes * 60000
  const earliest = Date.now() + s.minimum_notice_hours * 3600000, latest = Date.now() + s.max_days_ahead * 86400000
  const { data: taken, error } = await db.from('maktoub_intake_bookings').select('starts_at,ends_at,status,payment_hold_expires_at')
    .in('status', ACTIVE).gte('ends_at', new Date().toISOString())
  if (error) throw error
  const busy = (taken ?? []).filter(b => !(b.status === 'awaiting_payment' && b.payment_hold_expires_at && Date.parse(b.payment_hold_expires_at) <= Date.now()))
    .map(b => [Date.parse(b.starts_at), Date.parse(b.ends_at)])
  // Founder's Google Calendar busy times, synced by n8n every 15 minutes (start/end only).
  const { data: cal, error: calErr } = await db.from('maktoub_calendar_busy').select('starts_at,ends_at').gte('ends_at', new Date().toISOString())
  if (calErr) console.error('calendar busy read failed', calErr)
  for (const c of cal ?? []) busy.push([Date.parse(c.starts_at), Date.parse(c.ends_at)])
  // Founder days off (Riyadh dates): the whole day is unbookable.
  const { data: off, error: offErr } = await db.from('maktoub_blocked_dates').select('day')
  if (offErr) console.error('blocked dates read failed', offErr)
  const daysOff = new Set((off ?? []).map(o => String(o.day)))
  const slots: string[] = []
  const day0 = new Date(Date.now() + 3 * 3600000); day0.setUTCHours(0, 0, 0, 0)
  for (let d = 0; d <= s.max_days_ahead + 1; d++) {
    const dayUtc = day0.getTime() + d * 86400000 - 3 * 3600000 // Riyadh midnight in UTC ms
    if (daysOff.has(new Date(dayUtc + 3 * 3600000).toISOString().slice(0, 10))) continue
    for (let m = startMin; m + s.session_minutes <= endMin; m += 60) {
      const st = dayUtc + m * 60000, en = st + sessionMs
      if (st < earliest || st > latest) continue
      if (busy.some(([bs, be]) => bs < en + bufferMs && be + bufferMs > st)) continue
      slots.push(new Date(st + 3 * 3600000).toISOString().slice(0, 16) + ':00+03:00')
    }
  }
  return { timezone: s.timezone, session_minutes: s.session_minutes, slots }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(origin) })
  if (!origin || !ORIGINS.has(origin)) return json({ error: 'Forbidden' }, 403, origin)
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'

  try {
    if (req.method === 'GET') return json(await availableSlots(), 200, origin)
    if (req.method !== 'POST') return json({ error: 'Method' }, 405, origin)
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request.' }, 400, origin)
    const action = String(body.action || 'request')

    if (action === 'view' || action === 'approve' || action === 'decline') {
      if (await limited('decide:' + ip, 40, 3600)) return json({ error: 'Too many attempts. Try again later.' }, 429, origin)
      const id = str(body.id, 40), token = str(body.token, 200)
      if (!id || !UUID.test(id) || !token) return json({ error: 'This link is invalid.' }, 400, origin)
      const hash = await sha256(token)
      if (action === 'view') {
        const { data } = await db.from('maktoub_intake_bookings')
          .select('id,status,starts_at,booking_phone_e164,action_token_hash,action_token_expires_at,person:maktoub_people(full_name,normalized_phone)')
          .eq('id', id).maybeSingle()
        if (!data || data.action_token_hash !== hash) return json({ error: 'This link has expired or was already used.' }, 404, origin)
        const p = data.person as { full_name?: string; normalized_phone?: string } | null
        return json({ id: data.id, status: data.status, starts_at: data.starts_at, name: p?.full_name ?? '', phone: data.booking_phone_e164 || p?.normalized_phone || '' }, 200, origin)
      }
      const { data, error } = await db.rpc('maktoub_decide_booking', { p_id: id, p_token_hash: hash, p_decision: action })
      if (error) { console.error('decision failed', error); return json({ error: 'Could not record the decision. Try again.' }, 500, origin) }
      if (!Array.isArray(data) || !data[0]) return json({ error: 'This link has expired or was already used.' }, 409, origin)
      return json({ success: true, status: data[0].status }, 200, origin)
    }

    if (action !== 'request') return json({ error: 'Invalid request.' }, 400, origin)
    if (str(body.website, 200)) return json({ success: true }, 200, origin) // honeypot: bots get a silent no-op
    if (await limited('book-ip:' + ip, 6, 3600)) return json({ error: 'Too many requests. Please try again in an hour.' }, 429, origin)

    const fullName = str(body.full_name, 150), phoneRaw = str(body.phone, 60), email = str(body.email, 254)
    if (!fullName || !phoneRaw || body.consent !== true) return json({ error: 'Please complete your name, WhatsApp number and consent.' }, 400, origin)
    const iso = str(body.country_iso2, 2)?.toUpperCase()
    const parsed = parsePhoneNumberFromString(phoneRaw, iso && /^[A-Z]{2}$/.test(iso) ? iso as any : undefined)
    if (!parsed || !parsed.isValid()) return json({ error: 'Please enter your WhatsApp number in international format, e.g. +966 5X XXX XXXX.' }, 400, origin)
    const phone = parsed.number
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please check your email address, or leave it empty.' }, 400, origin)
    if (await limited('book-phone:' + phone, 4, 86400)) return json({ error: 'Too many requests for this number today.' }, 429, origin)

    const startsAt = str(body.starts_at, 40)
    const { slots } = await availableSlots()
    if (!startsAt || !slots.includes(startsAt)) return json({ error: 'That time is no longer available. Please choose another.' }, 409, origin)

    // Never overwrite the email that authorises an existing member's login.
    const { data: existing, error: exErr } = await db.from('maktoub_people').select('id,email').eq('normalized_phone', phone).maybeSingle()
    if (exErr) throw exErr
    const safeEmail = existing?.email ? null : email
    const { data: up, error: upErr } = await db.rpc('upsert_maktoub_person', {
      p_full_name: fullName, p_normalized_phone: phone, p_email: safeEmail, p_gender: null, p_preferred_language: null, p_city: null,
      p_source: 'maktoub_app', p_source_detail: 'direct_booking_page', p_referred_by_person_id: null, p_referred_by: null,
      p_interest_matchmaking: true, p_interest_social: false, p_interest_events: false, p_interest_referral: false,
      p_consent_status: 'consented', p_consented_at: new Date().toISOString(), p_internal_note: null,
    })
    const personId = Array.isArray(up) ? up[0]?.person_id : null
    if (upErr || !personId) { console.error('person upsert failed', upErr); return json({ error: 'We could not save your request. Please try again.' }, 500, origin) }

    const { data: active } = await db.from('maktoub_intake_bookings').select('id,starts_at').eq('person_id', personId).in('status', ACTIVE).limit(1)
    if (active?.length) return json({ error: 'You already have a consultation request with us. We will be in touch on WhatsApp.', existing_starts_at: active[0].starts_at }, 409, origin)

    const starts = new Date(startsAt)
    const { data: booking, error: bErr } = await db.from('maktoub_intake_bookings').insert({
      person_id: personId, starts_at: starts.toISOString(), booking_phone_e164: phone, booking_email: email,
      status: 'pending', payment_status: 'unpaid', payment_provider: 'none', payment_amount_minor: 0,
      timezone: 'Asia/Riyadh', requested_at: new Date().toISOString(),
    }).select('id,starts_at,ends_at,status').single()
    if (bErr) {
      console.error('booking insert failed', bErr)
      return json({ error: 'That time was just taken. Please choose another.' }, 409, origin)
    }
    // Trigger queue_maktoub_booking_notification writes the founder alert to the outbox in the same transaction.
    return json({ success: true, booking }, 200, origin)
  } catch (e) {
    console.error('maktoub-book error', e)
    return json({ error: 'Something went wrong on our side. Please try again.' }, 500, origin)
  }
})
