// Maktoub Lumi: a private AI conversation inside the portal.
// (Internal names stay maktoub-companion / maktoub_companion_*; Lumi is what people see.)
//
// Two doors, one function (the same doors as maktoub-programme):
//   1. Founder — maktoub.app/lumi/. A Supabase session whose user is a founder in maktoub_admins.
//      Room "private": the founder alone, no client data. Room "client": one named client's record,
//      read once when the thread opens, stripped of identifiers, frozen into the thread, logged in the
//      client's audit trail.
//   2. Client  — maktoub.app/ready/lumi/. The client's own private link (only its SHA-256 is stored).
//      Room "self": their own programme and published report. The founder cannot read these threads.
//
// Where the words go: this function is the only thing that talks to the model. Conversations go to
// Anthropic's API (Claude) and nowhere else: no analytics, no Telegram, no n8n, no logs of message text.
// Under Anthropic's commercial terms API data is not used for training. Request zero data retention on the
// Anthropic organisation for the strictest setting (see OPERATIONS.md).
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@1.5.0'
import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam } from 'npm:@anthropic-ai/sdk@1.5.0/resources/beta/messages/messages'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const API_KEY = (Deno.env.get('MAKTOUB_ANTHROPIC_API_KEY') || Deno.env.get('ANTHROPIC_API_KEY') || '').trim()
const claude = API_KEY ? new Anthropic({ apiKey: API_KEY, maxRetries: 2 }) : null
const MODEL = 'claude-opus-5-5'
const ORIGINS = new Set(['https://maktoub.app', 'https://www.maktoub.app'])
const TOKEN_RE = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 8000
const MAX_TURNS = 240

// ---------- utilities ----------
const corsHeaders = (o: string | null, type = 'application/json; charset=utf-8'): HeadersInit => ({
  'Content-Type': type, 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  ...(o && ORIGINS.has(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' } : {}),
})
const json = (b: unknown, s: number, o: string | null) => new Response(JSON.stringify(b), { status: s, headers: corsHeaders(o) })
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }

async function limited(key: string, max: number, secs: number) {
  const { data, error } = await db.rpc('maktoub_rate_hit', { p_key: await sha256(key), p_max: max, p_window_seconds: secs })
  if (error) { console.error('rate limit check failed', error.message); return false }
  return data === false
}
const logEvent = (enrolment_id: string, actor: 'client' | 'founder' | 'system', action: string, detail: Record<string, unknown> = {}) =>
  db.from('maktoub_enrolment_events').insert({ enrolment_id, actor, action, detail }).then(({ error }) => { if (error) console.error('event log failed', error.message) })

// ---------- the client's notice (shown verbatim, hashed, stored with their acceptance) ----------
const NOTICE_VERSION = 'MKT-LUMI-2026-11-v1'
const NOTICE = `Lumi

Lumi is a private AI you can talk to about your programme, your report and what you are working through. It is an AI, not a person, and not a doctor or therapist. For anything urgent, contact local emergency services (911 in Saudi Arabia) and tell the Maktoub team.

What Lumi can see: your programme dates and stage, the answers you gave in your intake, and your voice report once it has been published to you. It cannot see anything else.

Who can read your conversations: only you, from this private link. The Maktoub team cannot read them. We can see only that a conversation exists and when it was last used.

Where your words go: your messages are stored in Maktoub's own private database and sent to one AI provider, Anthropic (the makers of Claude), to write each reply. Anthropic does not use them to train its models. They are not shared with anyone else, and they are not used for marketing.

Deleting: you can delete any conversation at any time. Deleted conversations are removed from Maktoub's database permanently.`

// ---------- who is asking ----------
type Caller =
  | { kind: 'founder'; uid: string }
  | { kind: 'client'; en: Record<string, any> }

async function founderFrom(jwt: string): Promise<Caller> {
  const { data: identity, error } = await db.auth.getUser(jwt)
  if (error || !identity.user) throw new HttpError(401, 'Please sign in again.')
  const { data: admin } = await db.from('maktoub_admins').select('role').eq('user_id', identity.user.id).maybeSingle()
  if (admin?.role !== 'founder') throw new HttpError(403, 'Founder access required.')
  return { kind: 'founder', uid: identity.user.id }
}

async function clientFrom(token: unknown, ip: string): Promise<Caller> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    if (await limited('cmp-bad:' + ip, 20, 3600)) throw new HttpError(429, 'Too many attempts.')
    throw new HttpError(401, 'This private link is not valid.')
  }
  const { data: en, error } = await db.from('maktoub_enrolments').select('*').eq('invite_token_hash', await sha256(token)).maybeSingle()
  if (error) throw error
  if (!en || en.revoked_at) throw new HttpError(401, 'This private link is no longer valid. Please contact Maktoub for a new one.')
  if (!en.signed_at || ['invited', 'cancelled'].includes(en.stage)) throw new HttpError(403, 'Lumi opens once your agreement is signed.')
  return { kind: 'client', en }
}

async function consented(enrolmentId: string) {
  const { data } = await db.from('maktoub_companion_consents').select('notice_version,granted_at,withdrawn_at')
    .eq('enrolment_id', enrolmentId).order('granted_at', { ascending: false }).limit(1).maybeSingle()
  return !!data && !data.withdrawn_at && data.notice_version === NOTICE_VERSION
}

// ---------- context: what the model is allowed to know ----------
// Identifiers are removed before anything is frozen into a thread: the model sees the person, not their
// name, email, phone, birth date or address. Age replaces the birth date.
const IDENTIFYING = /^(full_name|name|email|phone|mobile|dob|date_of_birth|birth_time|birth_place|address|passport|national_id|iqama|signature_name|invited_name|invited_phone)$/i
const firstName = (en: Record<string, any>) => String(en.intake?.preferred_name || en.invited_name || '').trim().split(/\s+/)[0] || 'the client'
const ageOf = (dob: unknown) => {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null
  const d = new Date(dob + 'T00:00:00Z'), now = new Date()
  let a = now.getUTCFullYear() - d.getUTCFullYear()
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--
  return a
}
function scrub(v: unknown, names: string[]): unknown {
  if (typeof v === 'string') return names.reduce((s, n) => n.length > 2 ? s.split(n).join('[name]') : s, v)
  if (Array.isArray(v)) return v.map(x => scrub(x, names))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!IDENTIFYING.test(k) && x !== null && x !== '' && !(Array.isArray(x) && !x.length)) out[k] = scrub(x, names)
    return out
  }
  return v
}
// Full name and family name are replaced inside free text too; the first name stays so the reading feels human.
const namesToHide = (en: Record<string, any>) => {
  const full = [en.invited_name, en.intake?.full_name].filter(Boolean).map(String)
  const parts = full.flatMap(n => n.split(/\s+/)).filter(p => p.length > 2 && p !== firstName(en))
  return [...full, ...new Set(parts)].sort((a, b) => b.length - a.length)
}
const block = (tag: string, body: unknown, attrs = '') => `<${tag}${attrs}>\n${typeof body === 'string' ? body : JSON.stringify(body, null, 1)}\n</${tag}>`

async function programmeName(code: string) {
  const { data } = await db.from('maktoub_programmes').select('name,duration_days').eq('code', code).maybeSingle()
  return data || { name: code, duration_days: null }
}

async function founderClientSnapshot(en: Record<string, any>) {
  const [p, rep, asm] = await Promise.all([
    programmeName(en.programme_code),
    db.from('maktoub_voice_reports').select('data,status,published_at').eq('enrolment_id', en.id).maybeSingle(),
    db.from('maktoub_assessments').select('kind,instrument,scores,completed_at').eq('enrolment_id', en.id),
  ])
  const hide = namesToHide(en)
  const facts = {
    called: firstName(en), reference: en.reference_code, addressed_as: en.addressed_as, age: ageOf(en.intake?.dob),
    programme: p.name, stage: en.stage, start_date: en.start_date, end_date: en.end_date, pause_days: en.pause_days_total,
    voice_addon: en.voice_addon_status, medical_status: en.medical_status, medical_constraints: en.medical_constraints,
    test_record: en.is_test || undefined,
  }
  const parts = [
    block('client_facts', scrub(facts, hide)),
    en.intake && Object.keys(en.intake).length ? block('intake_answers_in_their_words', scrub(en.intake, hide)) : '',
    rep.data ? block('voice_report', scrub(rep.data.data, hide), ` status="${rep.data.status}"`) : '',
    asm.data?.some(a => a.completed_at) ? block('assessment_scores_founder_only', asm.data.filter(a => a.completed_at).map(a => ({ test: a.instrument, scores: a.scores }))) : '',
    en.founder_note ? block('your_private_note', scrub(en.founder_note, hide)) : '',
  ].filter(Boolean)
  return { text: `This conversation is about one client. Their record was read on ${new Date().toISOString().slice(0, 10)} and frozen here.\n\n${parts.join('\n\n')}`, scope: parts.map(p => p.slice(1).split(/[ >]/)[0]) }
}

async function clientSelfSnapshot(en: Record<string, any>) {
  const [p, rep] = await Promise.all([
    programmeName(en.programme_code),
    db.from('maktoub_voice_reports').select('data,status,published_at').eq('enrolment_id', en.id).maybeSingle(),
  ])
  const hide = namesToHide(en)
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)
  const day = en.start_date && en.stage === 'active' ? Math.round((Date.parse(today) - Date.parse(en.start_date)) / 86400e3) + 1 - (en.pause_days_total || 0) : null
  const facts = {
    called: firstName(en), addressed_as: en.addressed_as, programme: p.name, programme_length_days: p.duration_days,
    stage: en.stage, start_date: en.start_date, end_date: en.end_date, programme_day_today: day, today,
  }
  const published = rep.data?.status === 'published'
  const parts = [
    block('their_programme', scrub(facts, hide)),
    en.intake_submitted_at ? block('their_intake_answers', scrub(en.intake, hide)) : '',
    published ? block('their_published_voice_report', scrub(rep.data!.data, hide)) : '',
  ].filter(Boolean)
  return `What you know about the person you are talking with, as of ${today}. It is their own information; they shared it with Maktoub.${published ? '' : ' Their voice report has not been published to them yet: do not guess at what it will say.'}\n\n${parts.join('\n\n')}`
}

// ---------- who Lumi is ----------
// Kept byte-stable so the prefix caches across turns. Per-thread context goes in a second system block.
const FOUNDER_SYSTEM = `You are Lumi, the founder's private AI inside Maktoub, a Riyadh-based house for matchmaking, readiness and self-knowledge (The Readiness Programme, voice reports built from EmoWave voice analysis and the founder's own readings, personality assessments).

You are talking with the founder. Treat them as a peer with a scientific mind, high critical thinking and an intuitive, symbolic, cross-disciplinary range: they move between neuroscience, psychology, embodiment, spirituality and the esoteric, and they want you to move with them. Hold both registers at once. Say plainly what is evidence, what is a well-supported model, what is interpretation and what is pure intuition or symbol, and do that without flattening the intuitive into the merely clinical.

Write in flowing paragraphs. Do not use bullet points or headings unless asked. Be concise and go deep: one sharp insight over five safe ones. Disagree when you see it differently. Do not add disclaimers, safety warnings or reminders about professional help unless there is a genuine risk to someone.

When a client's record is attached, it is there for the founder's thinking: patterns, hypotheses, how to hold the next session, what to look for, how to word something for them. Work only from what the record says, quote it when it matters, and say when something is not in it rather than filling the gap. Keep EmoWave signals distinct from the founder's own readings. Never present a clinical diagnosis as fact. Assessment scores are founder-only and must never be worded for the client as scores.

Reply in the language the founder writes in.`

const clientSystem = (addressedAs: string) => `You are Lumi, Maktoub's private AI: a calm, warm presence for a client of The Readiness Programme at Maktoub, a Riyadh-based house for readiness, self-knowledge and matchmaking. You talk with one person, about their own programme, their voice report and what they are working through.

You are an AI, not a therapist, doctor or coach, and you say so if it matters. You do not diagnose, prescribe, interpret blood results or give medical advice; you can help them prepare questions for their own physician or for the Maktoub team. If they mention wanting to harm themselves or someone else, or describe an emergency, respond with care, encourage them to contact local emergency services (911 in Saudi Arabia) or someone they trust right now, and to tell the Maktoub team.

Speak to them directly as "you". In Arabic, address them in the ${addressedAs === 'woman' ? 'feminine' : 'masculine'} form. Reply in the language they write in. Keep replies short and human: a few sentences, in paragraphs, with a question back to them when it helps them reflect. No bullet points, no jargon, no tool or vendor names (never mention EmoWave or any test by its formal name).

Ground what you say in what you know about them, and never invent what is not there. Their voice report is a reflection, not a verdict: hold it lightly and help them find what is true for them in it. You cannot see the founder's notes, assessment scores, payments or medical files; if asked, say these are for their sessions with the Maktoub team. You cannot change bookings or their programme; point them to the portal or the team.`

// ---------- threads ----------
async function ownThread(c: Caller, id: unknown) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Conversation required.')
  const { data: t, error } = await db.from('maktoub_companion_threads').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  const mine = t && (c.kind === 'founder' ? t.owner === 'founder' && t.founder_uid === c.uid : t.owner === 'client' && t.enrolment_id === c.en.id)
  if (!mine) throw new HttpError(404, 'Conversation not found.')
  return t
}

async function listThreads(c: Caller) {
  let q = db.from('maktoub_companion_threads').select('id,room,enrolment_id,title,created_at,updated_at,context_read_at').order('updated_at', { ascending: false }).limit(100)
  q = c.kind === 'founder' ? q.eq('owner', 'founder').eq('founder_uid', c.uid) : q.eq('owner', 'client').eq('enrolment_id', c.en.id)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

// Replay exactly what was stored. After a mid-output model fallback, thinking blocks before the last
// fallback marker are omitted, as the API requires; everything else is echoed unchanged.
function replayContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const lastFallback = content.map(b => b.type).lastIndexOf('fallback')
  return (lastFallback < 0 ? content : content.filter((b, i) => i >= lastFallback || !['thinking', 'redacted_thinking', 'tool_use'].includes(b.type))) as unknown as BetaContentBlockParam[]
}

// ---------- the conversation ----------
async function send(c: Caller, t: Record<string, any>, text: string, origin: string) {
  if (!claude) throw new HttpError(503, 'Lumi is not connected yet.')
  const { data: rows, error } = await db.from('maktoub_companion_messages').select('id,role,text,content').eq('thread_id', t.id).order('id')
  if (error) throw error
  if ((rows || []).length >= MAX_TURNS * 2) throw new HttpError(409, 'This conversation is full. Please start a new one.')
  const { data: mine, error: insErr } = await db.from('maktoub_companion_messages').insert({ thread_id: t.id, role: 'user', text }).select('id').single()
  if (insErr) throw insErr
  if (!rows?.length) await db.from('maktoub_companion_threads').update({ title: text.replace(/\s+/g, ' ').slice(0, 70) }).eq('id', t.id)

  const messages: BetaMessageParam[] = (rows || []).map(r => r.role === 'assistant' && Array.isArray(r.content)
    ? { role: 'assistant' as const, content: replayContent(r.content) }
    : { role: r.role as 'user' | 'assistant', content: r.text })
  messages.push({ role: 'user', content: text })
  const system = [
    { type: 'text' as const, text: c.kind === 'founder' ? FOUNDER_SYSTEM : clientSystem(c.en.addressed_as) },
    ...(t.context_snapshot ? [{ type: 'text' as const, text: t.context_snapshot }] : []),
  ]

  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(ctl) {
      const out = (o: unknown) => ctl.enqueue(enc.encode(JSON.stringify(o) + '\n'))
      const undo = () => db.from('maktoub_companion_messages').delete().eq('id', mine.id)
      try {
        const stream = claude.beta.messages.stream({
          model: MODEL, max_tokens: 16000, system, messages,
          thinking: { type: 'adaptive' },
          output_config: { effort: c.kind === 'founder' ? 'high' : 'medium' },
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') out({ t: 'd', x: ev.delta.text })
        }
        const final = await stream.finalMessage()
        if (final.stop_reason === 'refusal') {
          await undo()
          out({ t: 'refused', x: 'I can’t help with that one. Could you put it another way?' })
        } else {
          const reply = final.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
          const { error: e2 } = await db.from('maktoub_companion_messages').insert({
            thread_id: t.id, role: 'assistant', text: reply.slice(0, 60000), content: final.content, model: final.model,
            usage: { input: final.usage.input_tokens, output: final.usage.output_tokens, cache_read: final.usage.cache_read_input_tokens, cache_write: final.usage.cache_creation_input_tokens },
          })
          if (e2) throw e2
          out({ t: 'done', truncated: final.stop_reason === 'max_tokens' || undefined })
        }
      } catch (e) {
        await undo()
        const status = e instanceof Anthropic.APIError ? e.status : undefined
        console.error('lumi model error', status, (e as Error).name)
        out({ t: 'error', x: status === 429 || status === 529 ? 'Lumi is busy for a moment. Please try again shortly.' : 'The reply did not come through. Please try again.' })
      } finally {
        ctl.close()
      }
    },
  })
  return new Response(body, { status: 200, headers: corsHeaders(origin, 'application/x-ndjson; charset=utf-8') })
}

async function handle(c: Caller, body: Record<string, any>, origin: string, req: Request, ip: string) {
  const action = String(body.action || '')
  const who = c.kind === 'founder' ? 'f:' + c.uid : 'c:' + c.en.id

  if (c.kind === 'client' && action === 'consent') {
    await db.from('maktoub_companion_consents').insert({
      enrolment_id: c.en.id, notice_version: NOTICE_VERSION, notice_sha256: await sha256(NOTICE), notice_snapshot: NOTICE,
      ip_hash: await sha256('ip:' + ip), user_agent: (req.headers.get('user-agent') || '').slice(0, 400),
    }).then(({ error }) => { if (error) throw error })
    logEvent(c.en.id, 'client', 'lumi_consented', { version: NOTICE_VERSION })
    return json({ success: true }, 200, origin)
  }
  if (c.kind === 'client' && action !== 'load' && !(await consented(c.en.id))) throw new HttpError(403, 'Please read and accept the Lumi notice first.')

  if (action === 'load') {
    const res: Record<string, unknown> = { connected: !!claude, threads: await listThreads(c) }
    if (c.kind === 'client') Object.assign(res, { consented: await consented(c.en.id), notice: NOTICE, notice_version: NOTICE_VERSION, first_name: firstName(c.en) })
    else {
      const { data } = await db.from('maktoub_enrolments').select('id,reference_code,invited_name,intake->>preferred_name,stage,is_test')
        .is('revoked_at', null).neq('stage', 'cancelled').order('created_at', { ascending: false }).limit(300)
      res.clients = (data || []).map(r => ({ id: r.id, reference: r.reference_code, name: r.invited_name, stage: r.stage, test: r.is_test }))
    }
    return json(res, 200, origin)
  }

  if (action === 'open') {
    let row: Record<string, unknown>
    if (c.kind === 'client') {
      row = { owner: 'client', room: 'self', enrolment_id: c.en.id, context_snapshot: await clientSelfSnapshot(c.en), context_read_at: new Date().toISOString() }
    } else if (body.room === 'client') {
      if (typeof body.enrolment_id !== 'string' || !UUID.test(body.enrolment_id)) throw new HttpError(400, 'Choose a client.')
      const { data: en } = await db.from('maktoub_enrolments').select('*').eq('id', body.enrolment_id).maybeSingle()
      if (!en) throw new HttpError(404, 'Client not found.')
      const snap = await founderClientSnapshot(en)
      row = { owner: 'founder', room: 'client', founder_uid: c.uid, enrolment_id: en.id, context_snapshot: snap.text, context_read_at: new Date().toISOString(), title: `${firstName(en)} · ${en.reference_code}` }
      logEvent(en.id, 'founder', 'lumi_record_read', { scope: snap.scope })
    } else {
      row = { owner: 'founder', room: 'private', founder_uid: c.uid }
    }
    const { data, error } = await db.from('maktoub_companion_threads').insert(row).select('id,room,enrolment_id,title,created_at,updated_at,context_read_at').single()
    if (error) throw error
    return json({ thread: data }, 200, origin)
  }

  if (action === 'get') {
    const t = await ownThread(c, body.thread_id)
    const { data, error } = await db.from('maktoub_companion_messages').select('role,text,created_at').eq('thread_id', t.id).order('id')
    if (error) throw error
    return json({ thread: { id: t.id, room: t.room, title: t.title, context_read_at: t.context_read_at }, messages: data || [] }, 200, origin)
  }

  if (action === 'send') {
    const t = await ownThread(c, body.thread_id)
    const text = str(body.text, MAX_TEXT)
    if (!text) throw new HttpError(400, 'Write something first.')
    const [hour, day] = c.kind === 'founder' ? [200, 1500] : [40, 150]
    if (await limited('cmp-h:' + who, hour, 3600) || await limited('cmp-d:' + who, day, 86400)) throw new HttpError(429, 'That is a lot of conversation for one sitting. Please come back a little later.')
    return send(c, t, text, origin)
  }

  if (action === 'rename') {
    const t = await ownThread(c, body.thread_id)
    const title = str(body.title, 120)
    if (!title) throw new HttpError(400, 'Title required.')
    await db.from('maktoub_companion_threads').update({ title }).eq('id', t.id)
    return json({ success: true }, 200, origin)
  }

  if (action === 'delete') {
    const t = await ownThread(c, body.thread_id)
    const { error } = await db.from('maktoub_companion_threads').delete().eq('id', t.id)
    if (error) throw error
    if (c.kind === 'client') logEvent(c.en.id, 'client', 'lumi_thread_deleted')
    return json({ success: true }, 200, origin)
  }

  throw new HttpError(400, 'Unknown action.')
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
  if (!origin || !ORIGINS.has(origin)) return json({ error: 'Forbidden' }, 403, origin)
  if (req.method !== 'POST') return json({ error: 'Method' }, 405, origin)
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
  try {
    if (await limited('cmp-ip:' + ip, 600, 3600)) throw new HttpError(429, 'Too many requests. Please wait a few minutes.')
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid request.')
    const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    const caller = jwt ? await founderFrom(jwt) : await clientFrom(body.token, ip)
    return await handle(caller, body, origin, req, ip)
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin)
    console.error('maktoub-companion error', (e as Error).message)
    return json({ error: 'Something went wrong on our side. Please try again.' }, 500, origin)
  }
})
