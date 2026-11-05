// Invitation-only client onboarding for maktoub.app/onboard/?invite=TOKEN
// and the founder console at maktoub.app/onboard/admin/.
//
// Client actions are gated by the invite token (only its SHA-256 is stored).
// Founder actions are gated by a Supabase session whose user is a founder in
// maktoub_admins (the same sign-in as /login/). All storage is private; the
// service role is the only reader/writer. Recordings are served to the founder
// only through short-lived signed URLs.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { parsePhoneNumberFromString } from 'npm:libphonenumber-js@1.11.20'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const ORIGINS = new Set(['https://maktoub.app', 'https://www.maktoub.app'])
const BUCKET = 'maktoub-onboarding'
const SITE = 'https://maktoub.app'
const TOKEN_RE = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_AUDIO = 25 * 1024 * 1024
const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
}

const headers = (o: string | null): HeadersInit => ({
  'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'Cache-Control': 'no-store',
  ...(o && ORIGINS.has(o) ? {
    'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  } : {}),
})
const json = (b: unknown, s: number, o: string | null) => new Response(JSON.stringify(b), { status: s, headers: headers(o) })
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }

const limited = async (key: string, max: number, secs: number) => {
  const { data, error } = await db.rpc('maktoub_rate_hit', { p_key: await sha256(key), p_max: max, p_window_seconds: secs })
  if (error) { console.error('rate limit check failed', error); return false }
  return data === false
}
const logEvent = (onboarding_id: string, actor: 'client' | 'founder' | 'system', action: string, detail: Record<string, unknown> = {}) =>
  db.from('maktoub_onboarding_events').insert({ onboarding_id, actor, action, detail }).then(({ error }) => { if (error) console.error('event log failed', error) })

const money = (minor: number, currency: string) =>
  `${currency} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

async function settings() {
  const { data, error } = await db.from('maktoub_onboarding_settings').select('*').eq('id', true).single()
  if (error || !data) throw new Error('settings unavailable')
  return data
}

// Render the immutable legal texts for one client. The exact rendered text is what is hashed and signed.
async function documents(s: Record<string, any>, ob: { price_minor: number; currency: string }) {
  const versions = [s.agreement_version, s.privacy_version, s.voice_version, s.research_version].filter(Boolean)
  const { data, error } = await db.from('maktoub_legal_documents').select('version,kind,title,body').in('version', versions)
  if (error || !data || data.length !== versions.length) throw new Error('legal documents unavailable')
  const provider = s.provider_legal_name || 'Maktoub'
  const order = ['agreement', 'privacy', 'voice_processing', 'voice_research']
  return Promise.all(data.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).map(async d => {
    const body = d.body.replaceAll('{{PROVIDER}}', provider).replaceAll('{{FEE}}', money(ob.price_minor, ob.currency)).trim()
    return { kind: d.kind, version: d.version, title: d.title, body, sha256: await sha256(d.version + '\n' + d.title + '\n' + body) }
  }))
}

const bankReady = (s: Record<string, any>) => !!(s.bank_verified_at && s.bank_account_name && s.bank_name && s.bank_iban)
const readyForRealInvites = (s: Record<string, any>) => bankReady(s) && !!s.provider_legal_name && !!s.agreement_approved_at

function stepOf(ob: Record<string, any>) {
  if (!ob.signed_at) return 1
  if (!ob.intake_submitted_at) return 2
  if (!ob.voice_submitted_at) return 3
  return 4
}

// ---------- Intake (Deenaal intake questions, adapted for Maktoub) ----------
const ENUMS: Record<string, string[]> = {
  marital_status: ['never_married', 'divorced', 'widowed', 'prefer_to_discuss'],
  children: ['no', 'yes'],
  marriage_intention: ['ready_when_right', 'within_12_months', 'serious_leading_to_marriage', 'exploring_readiness'],
}
const TEXT_LIMITS: Record<string, number> = {
  full_name: 150, email: 254, phone: 40, city: 120, nationality: 80, how_feel: 3000, how_want_to_feel: 3000,
  mental_health_note: 2000, family_involvement: 2000, extra_notes: 5000,
}
const SCORES = ['mental_health_score', 'physical_health_score', 'spiritual_score', 'chapter_essentials', 'chapter_dark', 'chapter_light']
const CONTACTS = ['Email', 'WhatsApp', 'Phone']

function cleanIntake(raw: unknown) {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const [k, max] of Object.entries(TEXT_LIMITS)) { const v = str(src[k], max); if (v) out[k] = v }
  for (const [k, allowed] of Object.entries(ENUMS)) if (typeof src[k] === 'string' && allowed.includes(src[k] as string)) out[k] = src[k]
  for (const k of SCORES) { const n = Number(src[k]); if (Number.isInteger(n) && n >= 1 && n <= 10) out[k] = n }
  if (typeof src.dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.dob)) out.dob = src.dob
  if (typeof src.birth_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(src.birth_time)) out.birth_time = src.birth_time
  if (Array.isArray(src.preferred_contact)) out.preferred_contact = CONTACTS.filter(c => (src.preferred_contact as unknown[]).includes(c))
  if (typeof src.wa_notify === 'boolean') out.wa_notify = src.wa_notify
  return out
}
function intakeProblems(i: Record<string, any>) {
  // Founder decision (5 Nov 2026): the onboarding intake is full name, email and date of birth only.
  const missing: string[] = []
  if (!i.full_name) missing.push('your full name')
  if (!i.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) missing.push('a valid email')
  if (!i.dob) missing.push('your date of birth')
  else {
    const age = (Date.now() - Date.parse(i.dob + 'T00:00:00Z')) / (365.25 * 86400000)
    if (!(age >= 18 && age < 100)) missing.push('a date of birth showing you are 18 or over')
  }
  return missing
}

// ---------- Client view ----------
async function clientView(ob: Record<string, any>, s: Record<string, any>) {
  const docs = await documents(s, ob)
  return {
    first_name: String(ob.invited_name).trim().split(/\s+/)[0],
    full_name: ob.invited_name, email: ob.invited_email, phone: ob.invited_phone,
    reference: ob.reference_code, is_test: ob.is_test,
    price: { minor: ob.price_minor, currency: ob.currency, label: money(ob.price_minor, ob.currency) },
    documents: docs,
    step: stepOf(ob),
    signed: ob.signed_at ? { at: ob.signed_at, name: ob.signature_name, version: ob.agreement_version, countersigned_at: ob.countersigned_at, countersigned_name: ob.countersigned_name } : null,
    intake: ob.intake || {}, intake_saved_at: ob.intake_saved_at, intake_submitted_at: ob.intake_submitted_at,
    voice: ob.voice_submitted_at ? { at: ob.voice_submitted_at, duration_seconds: ob.voice_duration_seconds } : null,
    voice_locked: !!ob.payment_verified_at,
    payment: {
      reported_at: ob.payment_reported_at, verified_at: ob.payment_verified_at,
      bank: bankReady(s) ? { account_name: s.bank_account_name, bank_name: s.bank_name, iban: s.bank_iban, swift: s.bank_swift } : null,
    },
    report_due_at: ob.report_due_at, report_delivered_at: ob.report_delivered_at,
    readiness_status: ob.readiness_status,
  }
}

async function loadInvite(token: unknown) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new HttpError(401, 'This invitation link is not valid.')
  const { data: ob, error } = await db.from('maktoub_onboarding').select('*').eq('invite_token_hash', await sha256(token)).maybeSingle()
  if (error) throw error
  if (!ob || ob.revoked_at) throw new HttpError(401, 'This invitation link is not valid. Please contact Maktoub for a new one.')
  if (Date.parse(ob.invite_expires_at) <= Date.now() && !ob.signed_at) throw new HttpError(401, 'This invitation has expired. Please contact Maktoub for a new one.')
  return ob
}

async function clientAction(req: Request, origin: string, ip: string) {
  if (await limited('onb-ip:' + ip, 300, 3600)) throw new HttpError(429, 'Too many requests. Please wait a few minutes.')
  const isForm = (req.headers.get('content-type') || '').startsWith('multipart/form-data')
  const form = isForm ? await req.formData().catch(() => null) : null
  const body = isForm ? null : await req.json().catch(() => null)
  const token = isForm ? form?.get('token') : body?.token
  const action = isForm ? 'voice' : String(body?.action || '')
  if (typeof token === 'string' && !TOKEN_RE.test(token) && await limited('onb-bad:' + ip, 20, 3600)) throw new HttpError(429, 'Too many attempts.')
  const ob = await loadInvite(token)
  const s = await settings()
  const now = new Date().toISOString()
  const update = async (changes: Record<string, unknown>) => {
    const { data, error } = await db.from('maktoub_onboarding').update(changes).eq('id', ob.id).select('*').single()
    if (error) throw error
    return data
  }

  if (action === 'load') {
    const fresh = await update({ last_seen_at: now, ...(ob.first_opened_at ? {} : { first_opened_at: now }) })
    if (!ob.first_opened_at) logEvent(ob.id, 'client', 'opened')
    return json(await clientView(fresh, s), 200, origin)
  }

  if (action === 'sign') {
    if (ob.signed_at) return json(await clientView(ob, s), 200, origin)
    const name = str(body.signature_name, 150)
    if (!name || name.replace(/[^\p{L}]/gu, '').length < 3 || !/\s/.test(name)) throw new HttpError(400, 'Please type your full name as your signature.')
    if (body.accept_agreement !== true || body.consent_privacy !== true || body.consent_voice !== true) {
      throw new HttpError(400, 'Please confirm the agreement and both consents to continue.')
    }
    const docs = await documents(s, ob)
    const sent = body.documents && typeof body.documents === 'object' ? body.documents as Record<string, string> : {}
    if (docs.some(d => sent[d.kind] !== d.sha256)) throw new HttpError(409, 'The agreement was updated while you were reading. Please review it again.')
    const ipHash = await sha256('ip:' + ip)
    const ua = (req.headers.get('user-agent') || '').slice(0, 400)
    // Agreement, privacy and voice processing are required; anonymised retention (voice_research) is optional and recorded either way.
    const { error: cErr } = await db.from('maktoub_onboarding_consents').insert(docs.map(d => ({
      onboarding_id: ob.id, person_id: ob.person_id, kind: d.kind, document_version: d.version, document_sha256: d.sha256,
      document_snapshot: d.title + '\n\n' + d.body, granted: d.kind === 'voice_research' ? body.consent_research === true : true,
      signature_name: name, ip_hash: ipHash, user_agent: ua,
    })))
    if (cErr) throw cErr
    const agreement = docs.find(d => d.kind === 'agreement')!
    const fresh = await update({ signed_at: now, signature_name: name, agreement_version: agreement.version, agreement_sha256: agreement.sha256 })
    logEvent(ob.id, 'client', 'signed', { versions: docs.map(d => d.version), research_consent: body.consent_research === true })
    return json(await clientView(fresh, s), 200, origin)
  }

  if (action === 'save_intake') {
    if (!ob.signed_at) throw new HttpError(409, 'Please sign the agreement first.')
    if (ob.intake_submitted_at) throw new HttpError(409, 'Your intake has already been submitted.')
    const intake = cleanIntake(body.intake)
    if (body.submit === true) {
      const missing = intakeProblems(intake)
      if (missing.length) throw new HttpError(400, 'Please add ' + missing.join(', ') + '.')
      const fresh = await update({ intake, intake_saved_at: now, intake_submitted_at: now })
      logEvent(ob.id, 'client', 'intake_submitted')
      return json(await clientView(fresh, s), 200, origin)
    }
    await update({ intake, intake_saved_at: now })
    return json({ saved_at: now }, 200, origin)
  }

  if (action === 'voice') {
    if (!ob.intake_submitted_at) throw new HttpError(409, 'Please complete your intake first.')
    if (ob.payment_verified_at) throw new HttpError(409, 'Your recording is already with the team.')
    if (await limited('onb-voice:' + ob.id, 12, 86400)) throw new HttpError(429, 'Too many uploads today. Please try again tomorrow.')
    const audio = form?.get('audio')
    if (!(audio instanceof File) || audio.size < 1000 || audio.size > MAX_AUDIO) throw new HttpError(400, 'The recording could not be read. Please record again.')
    const mime = (audio.type || '').split(';')[0].trim().toLowerCase()
    const ext = AUDIO_TYPES[mime]
    if (!ext) throw new HttpError(400, 'This recording format is not supported. Please try another browser.')
    const duration = Math.round(Number(form?.get('duration_seconds')))
    if (!Number.isFinite(duration) || duration < 15 || duration > 600) throw new HttpError(400, 'Please record between 15 seconds and 10 minutes.')
    const path = `${ob.id}/voice-${crypto.randomUUID()}.${ext}`
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, audio, { contentType: mime, upsert: false })
    if (upErr) { console.error('voice upload failed', upErr); throw new HttpError(500, 'The upload did not finish. Please try again.') }
    const previous = ob.voice_storage_path
    let fresh
    try {
      fresh = await update({ voice_storage_path: path, voice_mime: mime, voice_duration_seconds: duration, voice_submitted_at: ob.voice_submitted_at || now })
    } catch (e) {
      await db.storage.from(BUCKET).remove([path])
      throw e
    }
    if (previous && previous !== path) {
      const { error: rmErr } = await db.storage.from(BUCKET).remove([previous])
      if (rmErr) console.error('previous recording removal failed', rmErr)
    }
    logEvent(ob.id, 'client', previous ? 'voice_replaced' : 'voice_submitted', { duration_seconds: duration, bytes: audio.size })
    return json(await clientView(fresh, s), 200, origin)
  }

  if (action === 'report_payment') {
    if (!ob.voice_submitted_at) throw new HttpError(409, 'Please complete the earlier steps first.')
    if (!bankReady(s)) throw new HttpError(409, 'Bank details are being confirmed. Please wait for our message before transferring.')
    if (ob.payment_reported_at) return json(await clientView(ob, s), 200, origin)
    const note = [str(body.transfer_date, 20) && 'Date: ' + str(body.transfer_date, 20), str(body.sender_name, 150) && 'Sender: ' + str(body.sender_name, 150)]
      .filter(Boolean).join(' · ') || null
    const fresh = await update({ payment_reported_at: now, payment_client_note: note })
    logEvent(ob.id, 'client', 'payment_reported', { note })
    return json(await clientView(fresh, s), 200, origin)
  }

  throw new HttpError(400, 'Invalid request.')
}

// ---------- Founder console ----------
const LIST_COLS = 'id,person_id,reference_code,invited_name,invited_phone,invited_email,is_test,revoked_at,invite_expires_at,created_at,first_opened_at,last_seen_at,signed_at,intake_submitted_at,voice_submitted_at,payment_reported_at,payment_verified_at,report_due_at,report_delivered_at,consultation_completed_at,readiness_status,matchmaking_started_at,countersigned_at,price_minor,currency'

async function founderAction(req: Request, origin: string, ip: string, jwt: string) {
  const { data: identity, error: authErr } = await db.auth.getUser(jwt)
  if (authErr || !identity.user) throw new HttpError(401, 'Please sign in again.')
  const { data: admin } = await db.from('maktoub_admins').select('role').eq('user_id', identity.user.id).maybeSingle()
  if (admin?.role !== 'founder') throw new HttpError(403, 'Founder access required.')
  if (await limited('onb-admin:' + identity.user.id, 600, 3600)) throw new HttpError(429, 'Too many requests.')
  const uid = identity.user.id
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid request.')
  const action = String(body.action || '')
  const now = new Date().toISOString()
  const s = await settings()
  const getOne = async (id: unknown) => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Record required.')
    const { data, error } = await db.from('maktoub_onboarding').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    if (!data) throw new HttpError(404, 'Record not found.')
    return data
  }
  const publicSettings = () => ({
    price_minor: s.price_minor, currency: s.currency, provider_legal_name: s.provider_legal_name, provider_registration: s.provider_registration,
    bank_account_name: s.bank_account_name, bank_name: s.bank_name, bank_iban: s.bank_iban, bank_swift: s.bank_swift,
    bank_verified_at: s.bank_verified_at, agreement_version: s.agreement_version, agreement_approved_at: s.agreement_approved_at,
    invite_valid_days: s.invite_valid_days, ready_for_real_invites: readyForRealInvites(s),
  })

  if (action === 'admin_overview') {
    const { data, error } = await db.from('maktoub_onboarding').select(LIST_COLS).order('created_at', { ascending: false }).limit(300)
    if (error) throw error
    return json({ settings: publicSettings(), documents: await documents(s, { price_minor: s.price_minor, currency: s.currency }), records: data }, 200, origin)
  }

  if (action === 'admin_settings') {
    const changes: Record<string, unknown> = {}
    for (const k of ['provider_legal_name', 'provider_registration', 'bank_account_name', 'bank_name']) if (k in body) changes[k] = str(body[k], 200)
    if ('bank_iban' in body) changes.bank_iban = str(body.bank_iban, 40)?.replace(/\s+/g, '').toUpperCase() ?? null
    if ('bank_swift' in body) changes.bank_swift = str(body.bank_swift, 11)?.replace(/\s+/g, '').toUpperCase() ?? null
    const bankChanged = ['bank_account_name', 'bank_name', 'bank_iban', 'bank_swift'].some(k => k in changes && changes[k] !== s[k])
    if (bankChanged) { changes.bank_verified_at = null; changes.bank_verified_by = null }
    if (body.verify_bank === true) {
      const merged = { ...s, ...changes }
      if (!merged.bank_account_name || !merged.bank_name || !merged.bank_iban) throw new HttpError(400, 'Enter the account name, bank and IBAN before verifying.')
      changes.bank_verified_at = now; changes.bank_verified_by = uid
    }
    if (body.approve_agreement === true) {
      if (!(changes.provider_legal_name ?? s.provider_legal_name)) throw new HttpError(400, 'Enter the legal entity name before approving the agreement.')
      changes.agreement_approved_at = now; changes.agreement_approved_by = uid
    }
    if (!Object.keys(changes).length) throw new HttpError(400, 'No changes.')
    changes.updated_at = now
    const { error } = await db.from('maktoub_onboarding_settings').update(changes).eq('id', true)
    if (error) { if (error.code === '23514') throw new HttpError(400, 'Check the IBAN (SA + 22 characters) and SWIFT code.'); throw error }
    return json({ success: true }, 200, origin)
  }

  if (action === 'admin_invite') {
    const test = body.test === true
    if (!test && !readyForRealInvites(s)) throw new HttpError(409, 'Before inviting a real client: enter the legal entity name, verify the bank details and approve the agreement.')
    const name = str(body.full_name, 150)
    const parsed = parsePhoneNumberFromString(String(body.phone || ''), (str(body.country_iso2, 2) || 'SA').toUpperCase() as any)
    // Test invites must use Ofcom's fictional drama range, which libphonenumber (correctly) reports as not assignable.
    const fictional = test && /^\+447700900\d{3}$/.test(parsed?.number || '')
    if (!name || !(parsed?.isValid() || fictional)) throw new HttpError(400, 'Name and a valid phone number are required.')
    const email = str(body.email, 254)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Check the email address.')
    const phone = parsed.number
    let personId: string
    if (test) {
      if (!/^\+447700900\d{3}$/.test(phone)) throw new HttpError(400, 'Test invites must use a fictional number +44 7700 900xxx.')
      const { data: up, error } = await db.rpc('upsert_maktoub_person', {
        p_full_name: name, p_normalized_phone: phone, p_email: email, p_source: 'synthetic_test', p_source_detail: 'onboarding_test',
        p_interest_matchmaking: false, p_consent_status: 'unknown',
      })
      if (error || !up?.[0]?.person_id) throw error || new Error('person failed')
      personId = up[0].person_id
    } else {
      const { data: existing } = await db.from('maktoub_people').select('id,email').eq('normalized_phone', phone).maybeSingle()
      const { data: up, error } = await db.rpc('upsert_maktoub_person', {
        p_full_name: name, p_normalized_phone: phone, p_email: existing?.email ? null : email, p_source: 'founder_manual',
        p_source_detail: 'onboarding_invite', p_interest_matchmaking: true, p_consent_status: 'unknown',
      })
      if (error || !up?.[0]?.person_id) throw error || new Error('person failed')
      personId = up[0].person_id
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = 'MK-' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => alphabet[b % alphabet.length]).join('')
      const { data, error } = await db.from('maktoub_onboarding').insert({
        person_id: personId, reference_code: ref, invite_token_hash: await sha256(token),
        invite_expires_at: new Date(Date.now() + s.invite_valid_days * 86400000).toISOString(),
        is_test: test, invited_name: name, invited_phone: phone, invited_email: email,
        price_minor: s.price_minor, currency: s.currency, created_by: uid,
      }).select('id,reference_code').single()
      if (!error) {
        logEvent(data.id, 'founder', 'invited', { test })
        return json({ id: data.id, reference: data.reference_code, url: `${SITE}/onboard/?invite=${token}` }, 200, origin)
      }
      if (error.code === '23505' && String(error.message).includes('one_open_per_person')) throw new HttpError(409, 'This person already has an open invitation. Revoke it or reissue its link.')
      if (error.code !== '23505') throw error
    }
    throw new Error('could not allocate reference')
  }

  if (action === 'admin_get') {
    const ob = await getOne(body.id)
    const [{ data: consents }, { data: events }] = await Promise.all([
      db.from('maktoub_onboarding_consents').select('kind,document_version,document_sha256,document_snapshot,granted,signature_name,created_at,withdrawn_at').eq('onboarding_id', ob.id).order('created_at'),
      db.from('maktoub_onboarding_events').select('actor,action,detail,created_at').eq('onboarding_id', ob.id).order('created_at'),
    ])
    let voice_url: string | null = null
    if (ob.voice_storage_path) {
      const { data } = await db.storage.from(BUCKET).createSignedUrl(ob.voice_storage_path, 600)
      voice_url = data?.signedUrl ?? null
      logEvent(ob.id, 'founder', 'voice_url_issued')
    }
    const { invite_token_hash: _h, ...safe } = ob
    return json({ record: safe, consents, events, voice_url }, 200, origin)
  }

  if (action === 'admin_update') {
    const ob = await getOne(body.id)
    const changes: Record<string, unknown> = {}
    const op = String(body.op || '')
    if (op === 'verify_payment') {
      if (ob.payment_verified_at) throw new HttpError(409, 'Payment is already verified.')
      const ref = str(body.bank_reference, 120)
      if (!ref) throw new HttpError(400, 'Enter the bank reference you matched in the statement.')
      if (!ob.signed_at) throw new HttpError(409, 'The agreement has not been signed.')
      Object.assign(changes, { payment_verified_at: now, payment_verified_by: uid, payment_bank_reference: ref })
    } else if (op === 'countersign') {
      if (!ob.signed_at) throw new HttpError(409, 'The client has not signed yet.')
      if (ob.countersigned_at) throw new HttpError(409, 'Already countersigned.')
      const name = str(body.name, 150)
      if (!name) throw new HttpError(400, 'Type your name to countersign.')
      Object.assign(changes, { countersigned_at: now, countersigned_by: uid, countersigned_name: name })
    } else if (op === 'report_delivered') {
      if (!ob.report_due_at) throw new HttpError(409, 'The report clock has not started (payment and full submission needed).')
      changes.report_delivered_at = now
    } else if (op === 'consultation_completed') {
      if (!ob.report_delivered_at) throw new HttpError(409, 'Deliver the report first.')
      changes.consultation_completed_at = now
    } else if (op === 'readiness') {
      if (!['approved', 'not_yet', 'pending'].includes(body.status)) throw new HttpError(400, 'Invalid readiness.')
      if (body.status === 'approved' && !ob.consultation_completed_at) throw new HttpError(409, 'Readiness is decided after the consultation.')
      if (body.status !== 'approved' && ob.matchmaking_started_at) throw new HttpError(409, 'Matchmaking has already started.')
      Object.assign(changes, { readiness_status: body.status, readiness_decided_at: now, readiness_decided_by: uid })
    } else if (op === 'start_matchmaking') {
      if (ob.readiness_status !== 'approved') throw new HttpError(409, 'Matchmaking starts only after readiness approval.')
      if (!ob.payment_verified_at) throw new HttpError(409, 'Payment has not been verified.')
      changes.matchmaking_started_at = ob.matchmaking_started_at || now
    } else if (op === 'note') {
      changes.founder_note = str(body.note, 3000)
    } else if (op === 'revoke') {
      changes.revoked_at = now
    } else if (op === 'reissue') {
      if (ob.revoked_at) throw new HttpError(409, 'This invitation was revoked.')
      const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
      const { error } = await db.from('maktoub_onboarding').update({
        invite_token_hash: await sha256(token), invite_expires_at: new Date(Date.now() + s.invite_valid_days * 86400000).toISOString(),
      }).eq('id', ob.id)
      if (error) throw error
      logEvent(ob.id, 'founder', 'reissued')
      return json({ url: `${SITE}/onboard/?invite=${token}` }, 200, origin)
    } else throw new HttpError(400, 'Invalid update.')
    const { error } = await db.from('maktoub_onboarding').update(changes).eq('id', ob.id)
    if (error) throw error
    logEvent(ob.id, 'founder', op, op === 'note' ? {} : { ...changes, payment_verified_by: undefined, readiness_decided_by: undefined, countersigned_by: undefined })
    return json({ success: true }, 200, origin)
  }

  if (action === 'admin_purge_test') {
    const ob = await getOne(body.id)
    if (!ob.is_test) throw new HttpError(403, 'Only synthetic test records can be purged.')
    const { data: files } = await db.storage.from(BUCKET).list(ob.id)
    if (files?.length) await db.storage.from(BUCKET).remove(files.map(f => `${ob.id}/${f.name}`))
    for (const t of ['maktoub_onboarding_consents', 'maktoub_onboarding_events']) {
      const { error } = await db.from(t).delete().eq('onboarding_id', ob.id)
      if (error) throw error
    }
    await db.from('maktoub_notification_outbox').delete().eq('event_id', ob.id) // none expected: test records never alert
    const { error } = await db.from('maktoub_onboarding').delete().eq('id', ob.id)
    if (error) throw error
    const { data: others } = await db.from('maktoub_onboarding').select('id').eq('person_id', ob.person_id).limit(1)
    const { data: person } = await db.from('maktoub_people').select('source').eq('id', ob.person_id).maybeSingle()
    if (!others?.length && person?.source === 'synthetic_test') await db.from('maktoub_people').delete().eq('id', ob.person_id)
    return json({ success: true }, 200, origin)
  }

  throw new HttpError(400, 'Invalid request.')
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(origin) })
  if (!origin || !ORIGINS.has(origin)) return json({ error: 'Forbidden' }, 403, origin)
  if (req.method !== 'POST') return json({ error: 'Method' }, 405, origin)
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
  try {
    const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    return jwt ? await founderAction(req, origin, ip, jwt) : await clientAction(req, origin, ip)
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin)
    console.error('maktoub-onboard error', e)
    return json({ error: 'Something went wrong on our side. Please try again.' }, 500, origin)
  }
})
