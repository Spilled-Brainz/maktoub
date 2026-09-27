import { createClient } from 'npm:@supabase/supabase-js@2'
import { parsePhoneNumberFromString } from 'npm:libphonenumber-js@1.11.20'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing Supabase environment')

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const ALLOWED_ORIGINS = new Set([
  'https://maktoub.app',
  'https://www.maktoub.app',
  'https://deenaal.com',
  'https://www.deenaal.com',
])

const PUBLIC_SOURCES = new Set([
  'maktoub_app',
  'deenaal_joinprivatesocial',
  'referral',
  'event',
  'private_intake',
])

const corsHeaders = (origin: string | null): HeadersInit => {
  const h: HeadersInit = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  }
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h['Access-Control-Allow-Origin'] = origin
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    h['Access-Control-Allow-Headers'] = 'content-type'
  }
  return h
}

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) })

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const field = (p: Record<string, unknown>, key: string, max = 300): string | null => {
  const v = p[key]
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.slice(0, max)
}

const bool = (p: Record<string, unknown>, key: string): boolean => p[key] === true

function normalizePhone(raw: string, countryIso2?: string | null): string | null {
  try {
    const parsed = parsePhoneNumberFromString(raw, countryIso2 ? countryIso2.toUpperCase() as any : undefined)
    if (!parsed || !parsed.isValid()) return null
    return parsed.number
  } catch {
    return null
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin')

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }

  if (req.method !== 'POST') return json({ success: false }, 405, origin)
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json({ success: false }, 403, origin)

  try {
    const raw: unknown = await req.json()
    if (!isRecord(raw)) return json({ success: false, error: 'Invalid submission.' }, 400, origin)

    const fullName = field(raw, 'full_name', 150)
    const phoneRaw = field(raw, 'phone', 60)
    const countryIso2 = field(raw, 'country_iso2', 2)
    const source = field(raw, 'source', 60) ??
      (origin.includes('deenaal.com') ? 'deenaal_joinprivatesocial' : 'maktoub_app')
    const consent = raw.consent === true || raw.consent_to_process === true

    if (!fullName || !phoneRaw || !PUBLIC_SOURCES.has(source) || !consent) {
      return json({ success: false, error: 'Please check the required fields.' }, 400, origin)
    }

    const normalizedPhone = normalizePhone(phoneRaw, countryIso2)
    if (!normalizedPhone) {
      return json({ success: false, error: 'Please enter a valid international phone number.' }, 400, origin)
    }

    const email = field(raw, 'email', 254)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, error: 'Please enter a valid email address.' }, 400, origin)
    }

    const genderRaw = field(raw, 'gender', 30)
    const gender = genderRaw && ['male', 'female', 'other', 'prefer_not_to_say'].includes(genderRaw)
      ? genderRaw : null

    const language = field(raw, 'preferred_language', 60)
    const city = field(raw, 'city', 120)
    const sourceDetail = field(raw, 'source_detail', 200)
    const referralName = field(raw, 'referral_name', 150) ?? field(raw, 'referred_by', 150)
    const referralContactRaw = field(raw, 'referral_contact', 100)
    const referralContact = referralContactRaw ? normalizePhone(referralContactRaw, countryIso2) : null

    let referredByPersonId: string | null = null
    if (referralContact) {
      const { data: referrer } = await admin
        .from('maktoub_people')
        .select('id')
        .eq('normalized_phone', referralContact)
        .maybeSingle()
      referredByPersonId = referrer?.id ?? null
    }

    const interestMatchmaking = bool(raw, 'interest_matchmaking')
    const interestSocial = bool(raw, 'interest_social')
    const interestEvents = bool(raw, 'interest_events')
    const interestReferral = bool(raw, 'interest_referral')

    const { data: upserted, error: upsertError } = await admin.rpc('upsert_maktoub_person', {
      p_full_name: fullName,
      p_normalized_phone: normalizedPhone,
      p_email: email,
      p_gender: gender,
      p_preferred_language: language,
      p_city: city,
      p_source: source,
      p_source_detail: sourceDetail,
      p_referred_by_person_id: referredByPersonId,
      p_referred_by: referralName ?? referralContact,
      p_interest_matchmaking: interestMatchmaking,
      p_interest_social: interestSocial,
      p_interest_events: interestEvents,
      p_interest_referral: interestReferral,
      p_consent_status: 'consented',
      p_consented_at: new Date().toISOString(),
      p_internal_note: null,
    })

    if (upsertError || !Array.isArray(upserted) || !upserted[0]?.person_id) {
      console.error('Maktoub person upsert failed', upsertError)
      return json({ success: false, error: 'We could not process your submission right now.' }, 500, origin)
    }

    const personId = upserted[0].person_id as string

    // Event registrations are a distinct operational queue, linked to the canonical person.
    const eventId = sourceDetail?.startsWith('event_interest | ') ? sourceDetail.split(' | ')[1] : null
    if (interestEvents && eventId) {
      const { error: eventError } = await admin.from('maktoub_event_contacts')
        .upsert({ event_id: eventId, person_id: personId }, { onConflict: 'event_id,person_id', ignoreDuplicates: true })
      if (eventError) {
        console.error('Event registration failed', eventError)
        return json({ success: false, error: 'We could not register your event interest right now.' }, 500, origin)
      }
    }

    const botToken = Deno.env.get('MAKTOUB_TELEGRAM_BOT_TOKEN')
    const chatId = Deno.env.get('MAKTOUB_TELEGRAM_CHAT_ID')
    if (botToken && chatId && upserted[0].is_new) {
      try {
        const message = ['New Maktoub signup', fullName, normalizedPhone,
          eventId ? 'Event: ' + eventId : 'Interest: ' + [interestMatchmaking && 'matchmaking', interestSocial && 'social', interestEvents && 'events'].filter(Boolean).join(', '),
          'Source: ' + source].join('\\n')
        const response = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message }),
          signal: AbortSignal.timeout(3000),
        })
        if (!response.ok) console.error('Telegram signup notification failed', response.status)
      } catch (notificationError) {
        console.error('Telegram signup notification failed', notificationError)
      }
    }

    if (source === 'deenaal_joinprivatesocial') {
      const { error: legacyError } = await admin.from('private_social_leads').insert({
        full_name: fullName,
        phone: normalizedPhone,
        email,
        interest_social: interestSocial,
        interest_matchmaking: interestMatchmaking,
        interest_referral: interestReferral,
        referral_name: referralName,
        referral_contact: referralContactRaw,
        consent: true,
        source: 'deenaal_joinprivatesocial',
        maktoub_person_id: personId,
      })
      if (legacyError) console.error('Legacy social lead audit insert failed', legacyError)
    }

    return json({ success: true }, 200, origin)
  } catch (error) {
    console.error('ingest-maktoub-person failed', error)
    return json({ success: false, error: 'We could not process your submission right now.' }, 400, origin)
  }
})
