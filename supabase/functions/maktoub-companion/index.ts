// Maktoub Lumi: a private AI inside the portal and on Telegram.
// (Internal names stay maktoub-companion / maktoub_companion_*; Lumi is what people see.)
//
// Four doors, one function:
//   1. Founder  — maktoub.app/lumi/. A Supabase session whose user is a founder in maktoub_admins.
//      Room "private": the founder alone. Room "client": one client's record, read once, stripped of identifiers,
//      frozen into the thread and logged in the client's audit trail. Plus the check-in overview, and the client's
//      conversations only while that client has sharing on (the group chat is always visible: the founder is in it).
//   2. Client   — maktoub.app/ready/lumi/. The client's own private link (only its SHA-256 is stored).
//   3. Telegram — the Lumi bot's webhook, verified by Telegram's secret-token header. Private chats with linked
//      clients, and one group per client with the founder, linked by the founder with /link RP-XXXXXX.
//   4. Scheduler — pg_cron every 15 minutes (x-lumi-cron header): daily nudges, sparks, Friday summaries, the
//      founder's 22:00 digest.
//
// Where the words go: Maktoub's database, Anthropic's API (Claude) for each reply, and Telegram for Telegram chats.
// No analytics, no n8n, no logs of message text. Under Anthropic's commercial terms API data is not used for training.
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@1.5.0'
import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaTool, BetaToolResultBlockParam } from 'npm:@anthropic-ai/sdk@1.5.0/resources/beta/messages/messages'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const API_KEY = (Deno.env.get('MAKTOUB_ANTHROPIC_API_KEY') || Deno.env.get('ANTHROPIC_API_KEY') || '').trim()
const claude = API_KEY ? new Anthropic({ apiKey: API_KEY, maxRetries: 2 }) : null
const MODEL = 'claude-opus-5-5'
const SITE = 'https://maktoub.app'
const FN_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/maktoub-companion`
const ORIGINS = new Set(['https://maktoub.app', 'https://www.maktoub.app'])
const TOKEN_RE = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 8000
const MAX_TURNS = 240
const TZ = 'Asia/Riyadh'
// Lumi's own Telegram bot (clients talk to it). The founder's alerts and digest use the existing founder bot.
const LUMI_BOT = (Deno.env.get('MAKTOUB_LUMI_BOT_TOKEN') || '').trim()
const FOUNDER_BOT = (['MAKTOUB_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN', 'TG_BOT_TOKEN', 'BOT_TOKEN']
  .map(n => Deno.env.get(n)).find(Boolean) || '').trim()
const FOUNDER_CHAT = Deno.env.get('MAKTOUB_TELEGRAM_CHAT_ID') || '970663486'
const NUDGE_STAGES = new Set(['active'])

// ---------- utilities ----------
const corsHeaders = (o: string | null, type = 'application/json; charset=utf-8'): HeadersInit => ({
  'Content-Type': type, 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  ...(o && ORIGINS.has(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' } : {}),
})
const json = (b: unknown, s: number, o: string | null) => new Response(JSON.stringify(b), { status: s, headers: corsHeaders(o) })
const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)))
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }
type Row = Record<string, any>

async function limited(key: string, max: number, secs: number) {
  const { data, error } = await db.rpc('maktoub_rate_hit', { p_key: await sha256(key), p_max: max, p_window_seconds: secs })
  if (error) { console.error('rate limit check failed', error.message); return false }
  return data === false
}
const logEvent = (enrolment_id: string, actor: 'client' | 'founder' | 'system', action: string, detail: Record<string, unknown> = {}) =>
  db.from('maktoub_enrolment_events').insert({ enrolment_id, actor, action, detail }).then(({ error }) => { if (error) console.error('event log failed', error.message) })
async function config(key: string) {
  const { data } = await db.from('maktoub_internal_config').select('value').eq('key', key).maybeSingle()
  return (data?.value as string | undefined) || ''
}

// Local calendar for a client (Riyadh by default). Weeks run Saturday to Friday; the summary goes out on Friday.
function localNow(tz: string, d = new Date()) {
  let parts: Intl.DateTimeFormatPart[]
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(d) }
  catch { return localNow(TZ, d) }
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), hm: `${p.hour}:${p.minute}`, dow: p.weekday as string }
}
const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10)
const saturdayOf = (date: string) => addDays(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 1) % 7))

// ---------- Telegram ----------
async function tg(token: string, method: string, payload: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.ok) throw new Error(`telegram ${method} ${r.status} ${String(j.description || '').slice(0, 120)}`)
  return j.result
}
const lumiTg = (method: string, payload: Record<string, unknown>) => tg(LUMI_BOT, method, payload)
let botMe: { id: number; username: string } | null = null
async function lumiBot() { if (!botMe && LUMI_BOT) botMe = await lumiTg('getMe', {}); return botMe }
// Plain text for Telegram: no parse mode, so nothing a model writes can break formatting. Long replies are split.
const plain = (s: string) => s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
async function sayTo(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
  const chunks: string[] = []
  let rest = plain(text).trim()
  while (rest.length > 3900) { const cut = rest.lastIndexOf('\n', 3900) > 2000 ? rest.lastIndexOf('\n', 3900) : 3900; chunks.push(rest.slice(0, cut)); rest = rest.slice(cut).trim() }
  if (rest) chunks.push(rest)
  let last: Row | null = null
  for (let i = 0; i < chunks.length; i++) last = await lumiTg('sendMessage', { chat_id: chatId, text: chunks[i], disable_web_page_preview: true, ...(i === chunks.length - 1 ? extra : {}) })
  return last
}
async function alertFounder(html: string, url?: string) {
  if (!FOUNDER_BOT) { console.error('founder alert skipped: no founder bot token'); return false }
  try {
    await tg(FOUNDER_BOT, 'sendMessage', { chat_id: FOUNDER_CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...(url ? { reply_markup: { inline_keyboard: [[{ text: 'Open Lumi', url }]] } } : {}) })
    return true
  } catch (e) { console.error('founder alert failed', (e as Error).message); return false }
}

// ---------- the client's notice (shown verbatim, hashed, stored with their acceptance) ----------
const NOTICE_VERSION = 'MKT-LUMI-2026-11-v2'
const NOTICE = `Lumi

Lumi is a private AI you can talk to here and on Telegram about your programme, your report and what you are working through. It is an AI, not a person, and not a doctor or therapist. For anything urgent, contact local emergency services (911 in Saudi Arabia).

What Lumi can see: your programme dates and stage, your intake answers, your voice report once it has been published to you, and the check-ins you share with it.

What the Maktoub team sees: as you talk, Lumi keeps a short daily check-in (sleep, movement, food, energy, mood, stress and your protocol) and the wins you name. Lumi always tells you what it has noted, and the team sees those notes. Each Friday Lumi drafts a summary of your week; it reaches the team only if you approve it. Lumi passes on anything you ask it to. If you say something that suggests you or someone else may be in danger, it alerts the team straight away.

Your conversations: only you can read them, unless you choose to share them with the team. You can turn sharing on or off at any time. If the team opens a Telegram group with you and Lumi, everyone in that group can read it.

Telegram: if you connect Telegram, Lumi sends you a short check-in each day at a time you choose, and now and then a personal note. Telegram keeps those messages on its own servers, as it does for all your chats. Send /quiet to pause messages and /unlink to disconnect.

Where your words go: your messages are stored in Maktoub's private database and sent to one AI provider, Anthropic (the makers of Claude), to write each reply. Anthropic does not use them to train its models. They are not shared with anyone else, and they are not used for marketing.

Deleting: you can delete your conversations from your Lumi page at any time. They are then removed from Maktoub's database permanently.`

// ---------- who is asking ----------
type Caller =
  | { kind: 'founder'; uid: string }
  | { kind: 'client'; en: Row }

async function founderFrom(jwt: string): Promise<Caller> {
  const { data: identity, error } = await db.auth.getUser(jwt)
  if (error || !identity.user) throw new HttpError(401, 'Please sign in again.')
  const { data: admin } = await db.from('maktoub_admins').select('role').eq('user_id', identity.user.id).maybeSingle()
  if (admin?.role !== 'founder') throw new HttpError(403, 'Founder access required.')
  return { kind: 'founder', uid: identity.user.id }
}

const usable = (en: Row | null) => !!en && !en.revoked_at && !!en.signed_at && !['invited', 'cancelled'].includes(en.stage)
async function clientFrom(token: unknown, ip: string): Promise<Caller> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    if (await limited('cmp-bad:' + ip, 20, 3600)) throw new HttpError(429, 'Too many attempts.')
    throw new HttpError(401, 'This private link is not valid.')
  }
  const { data: en, error } = await db.from('maktoub_enrolments').select('*').eq('invite_token_hash', await sha256(token)).maybeSingle()
  if (error) throw error
  if (!en || en.revoked_at) throw new HttpError(401, 'This private link is no longer valid. Please contact Maktoub for a new one.')
  if (!usable(en)) throw new HttpError(403, 'Lumi opens once your agreement is signed.')
  return { kind: 'client', en }
}

async function consented(enrolmentId: string) {
  const { data } = await db.from('maktoub_companion_consents').select('notice_version,granted_at,withdrawn_at')
    .eq('enrolment_id', enrolmentId).order('granted_at', { ascending: false }).limit(1).maybeSingle()
  return !!data && !data.withdrawn_at && data.notice_version === NOTICE_VERSION
}
async function linkOf(enrolmentId: string) {
  const { data } = await db.from('maktoub_lumi_links').select('*').eq('enrolment_id', enrolmentId).maybeSingle()
  return data as Row | null
}
async function enrolment(id: string) {
  const { data } = await db.from('maktoub_enrolments').select('*').eq('id', id).maybeSingle()
  return data as Row | null
}

// ---------- context: what the model is allowed to know ----------
// Identifiers are removed before anything reaches the model: it sees the person, not their name, email, phone,
// birth date or address. Age replaces the birth date. The first name stays so it can speak to them.
const IDENTIFYING = /^(full_name|name|email|phone|mobile|dob|date_of_birth|birth_time|birth_place|address|passport|national_id|iqama|signature_name|invited_name|invited_phone)$/i
const firstName = (en: Row) => String(en.intake?.preferred_name || en.invited_name || '').trim().split(/\s+/)[0] || 'the client'
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
const namesToHide = (en: Row) => {
  const full = [en.invited_name, en.intake?.full_name].filter(Boolean).map(String)
  const parts = full.flatMap(n => n.split(/\s+/)).filter(p => p.length > 2 && p !== firstName(en))
  return [...full, ...new Set(parts)].sort((a, b) => b.length - a.length)
}
const block = (tag: string, body: unknown, attrs = '') => `<${tag}${attrs}>\n${typeof body === 'string' ? body : JSON.stringify(body, null, 1)}\n</${tag}>`
const CHECKIN_COLS = 'day,sleep_hours,sleep_quality,trained,movement,nutrition,nutrition_note,energy,mood,stress,on_mind,protocol_done,protocol_note'
const compact = (r: Row) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== ''))

async function programmeName(code: string) {
  const { data } = await db.from('maktoub_programmes').select('name,duration_days').eq('code', code).maybeSingle()
  return data || { name: code, duration_days: null }
}
async function journal(enrolmentId: string, days: number, opts: { approvedOnly: boolean }) {
  const since = addDays(localNow(TZ).date, -days)
  const [c, w, s] = await Promise.all([
    db.from('maktoub_lumi_checkins').select(CHECKIN_COLS).eq('enrolment_id', enrolmentId).gte('day', since).order('day'),
    db.from('maktoub_lumi_wins').select('quote,said_on').eq('enrolment_id', enrolmentId).order('said_on', { ascending: false }).limit(12),
    (() => { let q = db.from('maktoub_lumi_weekly').select('week_start,week_end,summary,status').eq('enrolment_id', enrolmentId).order('week_start', { ascending: false }).limit(3); if (opts.approvedOnly) q = q.eq('status', 'approved'); return q })(),
  ])
  return { checkins: (c.data || []).map(compact), wins: w.data || [], weekly: s.data || [] }
}

async function founderClientSnapshot(en: Row) {
  const [p, rep, asm, j] = await Promise.all([
    programmeName(en.programme_code),
    db.from('maktoub_voice_reports').select('data,status,published_at').eq('enrolment_id', en.id).maybeSingle(),
    db.from('maktoub_assessments').select('kind,instrument,scores,completed_at').eq('enrolment_id', en.id),
    journal(en.id, 21, { approvedOnly: true }),
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
    j.checkins.length ? block('daily_checkins_last_21_days', scrub(j.checkins, hide)) : '',
    j.wins.length ? block('wins_in_their_words', scrub(j.wins, hide)) : '',
    j.weekly.length ? block('weekly_summaries_they_approved', scrub(j.weekly, hide)) : '',
  ].filter(Boolean)
  return { text: `This conversation is about one client. Their record was read on ${new Date().toISOString().slice(0, 10)} and frozen here.\n\n${parts.join('\n\n')}`, scope: parts.map(p => p.slice(1).split(/[ >]/)[0]) }
}

async function clientSelfSnapshot(en: Row) {
  const [p, rep, j] = await Promise.all([
    programmeName(en.programme_code),
    db.from('maktoub_voice_reports').select('data,status,published_at').eq('enrolment_id', en.id).maybeSingle(),
    journal(en.id, 14, { approvedOnly: false }),
  ])
  const hide = namesToHide(en)
  const L = localNow(en.timezone || TZ)
  const day = en.start_date && en.stage === 'active' ? Math.round((Date.parse(L.date) - Date.parse(en.start_date)) / 86400e3) + 1 - (en.pause_days_total || 0) : null
  const facts = {
    called: firstName(en), addressed_as: en.addressed_as, programme: p.name, programme_length_days: p.duration_days,
    stage: en.stage, start_date: en.start_date, end_date: en.end_date, programme_day_today: day, today: L.date, weekday: L.dow,
  }
  const published = rep.data?.status === 'published'
  const parts = [
    block('their_programme', scrub(facts, hide)),
    en.intake_submitted_at ? block('their_intake_answers', scrub(en.intake, hide)) : '',
    published ? block('their_published_voice_report', scrub(rep.data!.data, hide)) : '',
    j.checkins.length ? block('their_checkins_last_14_days', scrub(j.checkins, hide)) : '',
    j.wins.length ? block('wins_they_named', scrub(j.wins, hide)) : '',
    j.weekly.length ? block('recent_weekly_summaries', scrub(j.weekly, hide)) : '',
  ].filter(Boolean)
  return `What you know about the person you are talking with, as of ${L.date}. It is their own information; they shared it with Maktoub.${published ? '' : ' Their voice report has not been published to them yet: do not guess at what it will say.'}\n\n${parts.join('\n\n')}`
}

// ---------- who Lumi is ----------
// Kept byte-stable so the prefix caches across turns. Per-thread context goes in a second system block.
const FOUNDER_SYSTEM = `You are Lumi, the founder's private AI inside Maktoub, a Riyadh-based house for matchmaking, readiness and self-knowledge (The Readiness Programme, voice reports built from EmoWave voice analysis and the founder's own readings, personality assessments).

You are talking with the founder. Treat them as a peer with a scientific mind, high critical thinking and an intuitive, symbolic, cross-disciplinary range: they move between neuroscience, psychology, embodiment, spirituality and the esoteric, and they want you to move with them. Hold both registers at once. Say plainly what is evidence, what is a well-supported model, what is interpretation and what is pure intuition or symbol, and do that without flattening the intuitive into the merely clinical.

Write in flowing paragraphs. Do not use bullet points or headings unless asked. Be concise and go deep: one sharp insight over five safe ones. Disagree when you see it differently. Do not add disclaimers, safety warnings or reminders about professional help unless there is a genuine risk to someone.

When a client's record is attached, it is there for the founder's thinking: patterns, hypotheses, how to hold the next session, what to look for, how to word something for them. Work only from what the record says, quote it when it matters, and say when something is not in it rather than filling the gap. Keep EmoWave signals distinct from the founder's own readings. Never present a clinical diagnosis as fact. Assessment scores are founder-only and must never be worded for the client as scores.

Reply in the language the founder writes in.`

const clientSystem = (addressedAs: string) => `You are Lumi, Maktoub's private AI: a calm, warm presence for a client of The Readiness Programme at Maktoub, a Riyadh-based house for readiness, self-knowledge and matchmaking. You talk with one person, about their own programme, their voice report and what they are working through.

You are an AI, not a therapist, doctor or coach, and you say so if it matters. You do not diagnose, prescribe, interpret blood results or give medical advice; you can help them prepare questions for their own physician or for the Maktoub team. If they mention wanting to harm themselves or someone else, or describe an emergency, respond with care, encourage them to contact local emergency services (911 in Saudi Arabia) or someone they trust right now, and use flag_urgent.

Speak to them directly as "you". In Arabic, address them in the ${addressedAs === 'woman' ? 'feminine' : 'masculine'} form. Reply in the language they write in. Keep replies short and human: a few sentences, in paragraphs, with a question back to them when it helps them reflect. No bullet points, no jargon, no tool or vendor names (never mention EmoWave or any test by its formal name).

Ground what you say in what you know about them, and never invent what is not there. Their voice report is a reflection, not a verdict: hold it lightly and help them find what is true for them in it. You cannot see the founder's notes, assessment scores, payments or medical files; if asked, say these are for their sessions with the Maktoub team. You cannot change bookings or their programme; point them to the portal or the team.

Keeping their check-in: as they tell you about their day, save it with record_checkin (sleep, training or movement, food, energy, mood, stress, what is on their mind, their protocol). Save only what they actually said; never guess. Then tell them in one short, natural line what you noted, so they always know what the Maktoub team will see. Do not interrogate: if something is missing, you may ask for one thing at most, lightly. When they name a win or a breakthrough, save it with record_win in their own words. Use pass_to_team only when they ask you to tell the team something.`

const GROUP_ADDENDUM = `

You are in a Telegram group with this client and the founder of Maktoub. Each message is labelled with who wrote it. Speak to both naturally and briefly. The client knows the founder reads this group. Never reveal anything from the client's private conversations with you, and never mention assessment scores.`

// ---------- tools (client rooms only) ----------
const TOOLS: BetaTool[] = [
  {
    name: 'record_checkin',
    description: 'Save what the client has told you about their day into their daily check-in, which the Maktoub team sees. Call it whenever they mention sleep, training or movement, food, energy, mood, stress, what is on their mind, or how their protocol went. Include only fields they actually told you about; omit everything else. Scores are 1 to 10; if they use a word ("exhausted", "great"), translate it to a reasonable number. Use day "yesterday" only when they are clearly talking about yesterday. Calling it again the same day updates the same check-in.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        day: { type: 'string', enum: ['today', 'yesterday'] },
        sleep_hours: { type: 'number', description: 'Hours slept, 0 to 16.' },
        sleep_quality: { type: 'integer', description: '1 (terrible) to 10 (excellent).' },
        trained: { type: 'boolean', description: 'Whether they trained or did their planned movement.' },
        movement: { type: 'string', description: 'What they did, in a few words.' },
        nutrition: { type: 'string', enum: ['on_plan', 'mostly', 'off_plan'] },
        nutrition_note: { type: 'string' },
        energy: { type: 'integer', description: '1 (empty) to 10 (full).' },
        mood: { type: 'integer', description: '1 (very low) to 10 (excellent).' },
        stress: { type: 'integer', description: '1 (light) to 10 (crushing).' },
        on_mind: { type: 'string', description: 'One line on what is weighing on them or what went well.' },
        protocol_done: { type: 'string', enum: ['all', 'some', 'none'] },
        protocol_note: { type: 'string', description: 'What got in the way, if anything.' },
      },
      required: ['day'],
    },
  },
  {
    name: 'record_win',
    description: 'Save a win or breakthrough the client names, in their own words (a short quote, lightly trimmed). The Maktoub team sees it, and it is kept for their day-90 review.',
    input_schema: { type: 'object', additionalProperties: false, properties: { quote: { type: 'string' } }, required: ['quote'] },
  },
  {
    name: 'pass_to_team',
    description: 'Only when the client explicitly asks you to tell or pass something on to the Maktoub team. The note reaches the team in tonight\'s update. Write it in a sentence or two, faithful to what they asked.',
    input_schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'flag_urgent',
    description: 'Only if the client says something suggesting they or someone else may be in danger: self-harm, harm to others, or a medical emergency. Alerts the founder immediately. Still answer them with care and point them to 911.',
    input_schema: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', description: 'One factual sentence on what they said.' } }, required: ['reason'] },
  },
]
const toolsFor = (room: string) => room === 'group' ? TOOLS.filter(t => t.name !== 'pass_to_team') : ['self', 'telegram'].includes(room) ? TOOLS : []

const int10 = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10 ? v as number : undefined
const oneOf = <T extends string>(v: unknown, opts: readonly T[]) => typeof v === 'string' && (opts as readonly string[]).includes(v) ? v as T : undefined
async function runTool(en: Row, source: string, name: string, input: Row): Promise<{ text: string; error?: boolean }> {
  const today = localNow(en.timezone || TZ).date
  if (name === 'record_checkin') {
    const fields: Row = {
      sleep_hours: typeof input.sleep_hours === 'number' && input.sleep_hours >= 0 && input.sleep_hours <= 16 ? Math.round(input.sleep_hours * 10) / 10 : undefined,
      sleep_quality: int10(input.sleep_quality), energy: int10(input.energy), mood: int10(input.mood), stress: int10(input.stress),
      trained: typeof input.trained === 'boolean' ? input.trained : undefined,
      movement: str(input.movement, 300) ?? undefined, nutrition: oneOf(input.nutrition, ['on_plan', 'mostly', 'off_plan'] as const),
      nutrition_note: str(input.nutrition_note, 300) ?? undefined, on_mind: str(input.on_mind, 600) ?? undefined,
      protocol_done: oneOf(input.protocol_done, ['all', 'some', 'none'] as const), protocol_note: str(input.protocol_note, 400) ?? undefined,
    }
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
    if (!Object.keys(clean).length) return { text: 'Nothing valid to save. Scores must be whole numbers from 1 to 10.', error: true }
    const day = input.day === 'yesterday' ? addDays(today, -1) : today
    const { error } = await db.from('maktoub_lumi_checkins').upsert({ enrolment_id: en.id, day, source, ...clean }, { onConflict: 'enrolment_id,day' })
    if (error) { console.error('checkin save failed', error.message); return { text: 'Saving failed. Tell them you could not note it this time.', error: true } }
    return { text: `Saved to the check-in for ${day}: ${Object.entries(clean).map(([k, v]) => `${k} ${v}`).join(', ')}.` }
  }
  if (name === 'record_win') {
    const quote = str(input.quote, 600)
    if (!quote) return { text: 'No quote given.', error: true }
    const { error } = await db.from('maktoub_lumi_wins').insert({ enrolment_id: en.id, quote, said_on: today })
    return error ? { text: 'Saving failed.', error: true } : { text: 'Win saved.' }
  }
  if (name === 'pass_to_team') {
    const note = str(input.note, 1000)
    if (!note) return { text: 'No note given.', error: true }
    const { error } = await db.from('maktoub_lumi_notes').insert({ enrolment_id: en.id, note })
    return error ? { text: 'Saving failed.', error: true } : { text: 'Noted. It reaches the team in tonight\'s update.' }
  }
  if (name === 'flag_urgent') {
    const reason = str(input.reason, 1000) || 'Lumi flagged a possible risk.'
    await db.from('maktoub_lumi_notes').insert({ enrolment_id: en.id, note: reason, urgent: true })
    logEvent(en.id, 'system', 'lumi_urgent_flag')
    const sent = await alertFounder(`⚠️ <b>Lumi urgent flag</b> · ${esc(firstName(en))} · ${esc(en.reference_code)}\n\n${esc(reason)}`, `${SITE}/lumi/#checkins`)
    return { text: sent ? 'The founder has been alerted now.' : 'The alert is recorded; the founder will see it in the console.' }
  }
  return { text: `Unknown tool ${name}.`, error: true }
}

// ---------- threads ----------
const THREAD_COLS = 'id,room,enrolment_id,title,created_at,updated_at,context_read_at,period_start'
async function ownThread(c: Caller, id: unknown) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Conversation required.')
  const { data: t, error } = await db.from('maktoub_companion_threads').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  const mine = t && (c.kind === 'founder' ? t.owner === 'founder' && t.founder_uid === c.uid : t.owner === 'client' && t.enrolment_id === c.en.id)
  if (!mine) throw new HttpError(404, 'Conversation not found.')
  return t as Row
}
async function listThreads(c: Caller) {
  let q = db.from('maktoub_companion_threads').select(THREAD_COLS).order('updated_at', { ascending: false }).limit(100)
  q = c.kind === 'founder' ? q.eq('owner', 'founder').eq('founder_uid', c.uid) : q.eq('owner', 'client').eq('enrolment_id', c.en.id)
  const { data, error } = await q
  if (error) throw error
  return data || []
}
// One Telegram thread per room per week, so each week starts with fresh context and conversations stay bounded.
async function weekThread(en: Row, room: 'telegram' | 'group') {
  const week = saturdayOf(localNow(en.timezone || TZ).date)
  const { data: found } = await db.from('maktoub_companion_threads').select('*').eq('enrolment_id', en.id).eq('room', room).eq('period_start', week).maybeSingle()
  if (found) return found as Row
  const label = room === 'group' ? 'Group' : 'Telegram'
  const { data, error } = await db.from('maktoub_companion_threads').insert({
    owner: 'client', room, enrolment_id: en.id, period_start: week, title: `${label} · week of ${week}`,
    context_snapshot: await clientSelfSnapshot(en), context_read_at: new Date().toISOString(),
  }).select('*').single()
  if (error) {
    const { data: again } = await db.from('maktoub_companion_threads').select('*').eq('enrolment_id', en.id).eq('room', room).eq('period_start', week).maybeSingle()
    if (again) return again as Row
    throw error
  }
  return data as Row
}

// Replay exactly what was stored. After a mid-output model fallback, thinking and tool-use blocks before the last
// fallback marker are omitted, as the API requires; everything else is echoed unchanged.
function replayContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const lastFallback = content.map(b => b.type).lastIndexOf('fallback')
  return (lastFallback < 0 ? content : content.filter((b, i) => i >= lastFallback || !['thinking', 'redacted_thinking', 'tool_use'].includes(b.type))) as unknown as BetaContentBlockParam[]
}
// Rebuilds the conversation deterministically from stored rows. Messages Lumi sent on its own (nudges, sparks,
// summaries) are folded into the client's next message, so roles always alternate and earlier turns never change.
function buildHistory(rows: Row[], labels: Record<string, string>) {
  const out: BetaMessageParam[] = []
  let pending: string[] = []
  const prefix = () => pending.length ? `[Lumi sent this on its own before they wrote:\n${pending.join('\n---\n')}]\n\n` : ''
  for (const r of rows) {
    if (r.kind === 'outbound') { pending.push(r.text); continue }
    if (r.role === 'assistant') { out.push({ role: 'assistant', content: Array.isArray(r.content) ? replayContent(r.content) : r.text }); continue }
    if (r.kind === 'tool') { out.push({ role: 'user', content: r.content as BetaToolResultBlockParam[] }); continue }
    out.push({ role: 'user', content: prefix() + (r.speaker ? `[${labels[r.speaker] || r.speaker}] ` : '') + r.text })
    pending = []
  }
  return { messages: out, prefix: prefix() }
}

// ---------- one turn of conversation (web streaming, Telegram and the group all use this) ----------
type TurnResult = { text: string; refused?: boolean; truncated?: boolean }
async function runTurn(t: Row, system: { type: 'text'; text: string }[], userText: string, opts: {
  en?: Row; source?: string; speaker?: 'client' | 'founder'; labels?: Record<string, string>; tgMessageId?: number;
  effort: 'low' | 'medium' | 'high'; maxTokens: number; onDelta?: (s: string) => void
}): Promise<TurnResult> {
  if (!claude) throw new HttpError(503, 'Lumi is not connected yet.')
  const { data: rows, error } = await db.from('maktoub_companion_messages').select('id,role,text,content,kind,speaker').eq('thread_id', t.id).order('id')
  if (error) throw error
  if ((rows || []).length >= MAX_TURNS * 3) throw new HttpError(409, 'This conversation is full. Please start a new one.')
  const hist = buildHistory(rows || [], opts.labels || {})
  const inserted: number[] = []
  const save = async (row: Row) => {
    const { data, error: e } = await db.from('maktoub_companion_messages').insert({ thread_id: t.id, ...row }).select('id').single()
    if (e) throw e
    inserted.push(data.id)
  }
  await save({ role: 'user', text: userText, kind: 'chat', speaker: opts.speaker || null, tg_message_id: opts.tgMessageId || null })
  if (!(rows || []).some(r => r.kind === 'chat' && r.role === 'user') && t.room !== 'telegram' && t.room !== 'group')
    await db.from('maktoub_companion_threads').update({ title: userText.replace(/\s+/g, ' ').slice(0, 70) }).eq('id', t.id)

  const messages: BetaMessageParam[] = [...hist.messages, { role: 'user', content: hist.prefix + (opts.speaker ? `[${opts.labels?.[opts.speaker] || opts.speaker}] ` : '') + userText }]
  const tools = opts.en ? toolsFor(t.room) : []
  const said: string[] = []
  try {
    for (let step = 0; step < 6; step++) {
      const stream = claude.beta.messages.stream({
        model: MODEL, max_tokens: opts.maxTokens, system, messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: opts.effort },
        cache_control: { type: 'ephemeral' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        ...(tools.length ? { tools: tools.map(x => ({ ...x, eager_input_streaming: true })) } : {}),
      })
      let first = true
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && opts.onDelta) {
          if (first && said.length) opts.onDelta('\n\n')
          first = false
          opts.onDelta(ev.delta.text)
        }
      }
      const final = await stream.finalMessage()
      if (final.stop_reason === 'refusal') {
        await db.from('maktoub_companion_messages').delete().in('id', inserted)
        return { text: '', refused: true }
      }
      const text = final.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('').trim()
      if (text) said.push(text)
      const lastFallback = final.content.map(b => b.type).lastIndexOf('fallback')
      const calls = final.stop_reason === 'tool_use'
        ? final.content.filter((b, i) => b.type === 'tool_use' && i > lastFallback) as { type: 'tool_use'; id: string; name: string; input: unknown }[]
        : []
      await save({
        role: 'assistant', text: text.slice(0, 60000), content: final.content, model: final.model, kind: calls.length ? 'tool' : 'chat',
        usage: { input: final.usage.input_tokens, output: final.usage.output_tokens, cache_read: final.usage.cache_read_input_tokens, cache_write: final.usage.cache_creation_input_tokens },
      })
      if (!calls.length) return { text: said.join('\n\n'), truncated: final.stop_reason === 'max_tokens' }
      const results: BetaToolResultBlockParam[] = []
      for (const call of calls) {
        const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Row : null
        const r = input && opts.en ? await runTool(opts.en, opts.source || 'web', call.name, input) : { text: 'Invalid input.', error: true }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r.text, ...(r.error ? { is_error: true } : {}) })
      }
      await save({ role: 'user', text: '', content: results, kind: 'tool' })
      messages.push({ role: 'assistant', content: replayContent(final.content) }, { role: 'user', content: results })
    }
    return { text: said.join('\n\n') }
  } catch (e) {
    await db.from('maktoub_companion_messages').delete().in('id', inserted)
    throw e
  }
}
const modelErrorText = (e: unknown) => {
  const status = e instanceof Anthropic.APIError ? e.status : undefined
  console.error('lumi model error', status, (e as Error).name, e instanceof HttpError ? e.message : '')
  if (e instanceof HttpError) return e.message
  return status === 429 || status === 529 ? 'Lumi is busy for a moment. Please try again shortly.' : 'The reply did not come through. Please try again.'
}
function systemFor(c: Caller, t: Row) {
  const base = c.kind === 'founder' ? FOUNDER_SYSTEM : clientSystem(c.en.addressed_as)
  return [{ type: 'text' as const, text: base }, ...(t.context_snapshot ? [{ type: 'text' as const, text: t.context_snapshot }] : [])]
}

// Web: stream the reply as NDJSON lines.
function streamTurn(c: Caller, t: Row, text: string, origin: string) {
  if (!claude) throw new HttpError(503, 'Lumi is not connected yet.')
  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(ctl) {
      const out = (o: unknown) => ctl.enqueue(enc.encode(JSON.stringify(o) + '\n'))
      try {
        const r = await runTurn(t, systemFor(c, t), text, {
          en: c.kind === 'client' ? c.en : undefined, source: 'web', effort: c.kind === 'founder' ? 'high' : 'medium', maxTokens: 16000,
          onDelta: x => out({ t: 'd', x }),
        })
        if (r.refused) out({ t: 'refused', x: 'I can’t help with that one. Could you put it another way?' })
        else out({ t: 'done', truncated: r.truncated || undefined })
      } catch (e) {
        out({ t: 'error', x: modelErrorText(e) })
      } finally { ctl.close() }
    },
  })
  return new Response(body, { status: 200, headers: corsHeaders(origin, 'application/x-ndjson; charset=utf-8') })
}

// ---------- proactive messages (scheduler) ----------
async function compose(en: Row, instruction: string) {
  if (!claude) return ''
  const r = await claude.beta.messages.create({
    model: MODEL, max_tokens: 2000,
    system: [{ type: 'text', text: clientSystem(en.addressed_as) }, { type: 'text', text: await clientSelfSnapshot(en) }],
    messages: [{ role: 'user', content: instruction }],
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  })
  if (r.stop_reason === 'refusal') return ''
  return r.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('').trim()
}
async function recentOutbound(threadId: string) {
  const { data } = await db.from('maktoub_companion_messages').select('text').eq('thread_id', threadId).eq('kind', 'outbound').order('id', { ascending: false }).limit(4)
  return (data || []).map(r => r.text)
}
async function sendOutbound(en: Row, link: Row, text: string, extra: Record<string, unknown> = {}) {
  const t = await weekThread(en, 'telegram')
  const sent = await sayTo(link.tg_chat_id, text, extra)
  await db.from('maktoub_companion_messages').insert({ thread_id: t.id, role: 'assistant', kind: 'outbound', text, tg_message_id: sent?.message_id || null })
  return sent
}
async function nudge(en: Row, link: Row) {
  const t = await weekThread(en, 'telegram')
  const before = await recentOutbound(t.id)
  const text = await compose(en, `Write today's evening check-in message to send them on Telegram. One to three short sentences, warm and specific to them: their goals, how the last few days went, where they are in the programme. Invite them to tell you about their day (sleep, movement, food, energy, mood, their protocol) without listing these like a form. Do not repeat the shape of these recent messages:\n${before.join('\n---\n') || '(none yet)'}\n\nOutput only the message.`)
  if (text) await sendOutbound(en, link, text)
}
async function spark(en: Row, link: Row) {
  const t = await weekThread(en, 'telegram')
  const before = await recentOutbound(t.id)
  const text = await compose(en, `Send them a short, unprompted personal note on Telegram: a reflection, an encouragement or one good question, tied to something specific in their goals, their report or their recent check-ins. Not a check-in request and not generic motivation. One or two sentences. Do not repeat these recent messages:\n${before.join('\n---\n') || '(none yet)'}\n\nOutput only the message.`)
  if (text) await sendOutbound(en, link, text)
}
async function weekly(en: Row, link: Row, today: string) {
  const start = saturdayOf(today)
  const [c, w] = await Promise.all([
    db.from('maktoub_lumi_checkins').select(CHECKIN_COLS).eq('enrolment_id', en.id).gte('day', start).lte('day', today).order('day'),
    db.from('maktoub_lumi_wins').select('quote,said_on').eq('enrolment_id', en.id).gte('said_on', start).lte('said_on', today),
  ])
  const hide = namesToHide(en)
  const summary = await compose(en, `It is Friday. Write the summary of their week (${start} to ${today}) for the Maktoub team. They will read it first and decide whether it is sent. Write it about them, in the third person using their first name, in four to seven plain sentences: sleep, movement, food, energy, mood and stress across the week, how the protocol went, what stood out, and their wins in their own words. Report only what is in the data; if there were few check-ins, say so simply. No advice, no diagnosis.\n\n${block('checkins_this_week', scrub((c.data || []).map(compact), hide))}\n\n${block('wins_this_week', scrub(w.data || [], hide))}\n\nOutput only the summary.`)
  if (!summary) return
  const { data: row, error } = await db.from('maktoub_lumi_weekly').upsert({ enrolment_id: en.id, week_start: start, week_end: today, summary, status: 'draft', decided_at: null }, { onConflict: 'enrolment_id,week_start' }).select('id').single()
  if (error) { console.error('weekly save failed', error.message); return }
  const text = `Your week, as I would pass it on to the Maktoub team:\n\n${summary}\n\nShall I send it? Nothing reaches them unless you say yes. And when you are ready, tell me how today went.`
  const sent = await sendOutbound(en, link, text, { reply_markup: { inline_keyboard: [[{ text: 'Send it', callback_data: `wk:a:${row.id}` }, { text: 'Keep it private', callback_data: `wk:d:${row.id}` }]] } })
  if (sent?.message_id) await db.from('maktoub_lumi_weekly').update({ tg_message_id: sent.message_id }).eq('id', row.id)
}

// Founder digest at 22:00 Riyadh: structured, written without the model, sent on the founder bot.
async function digest(today: string) {
  const { data: links } = await db.from('maktoub_lumi_links').select('enrolment_id,tg_chat_id,share_conversations').not('tg_chat_id', 'is', null)
  if (!links?.length) return
  const ids = links.map(l => l.enrolment_id)
  const [ens, cks, wins, notes, weeks] = await Promise.all([
    db.from('maktoub_enrolments').select('id,reference_code,invited_name,intake,stage,is_test').in('id', ids),
    db.from('maktoub_lumi_checkins').select('enrolment_id,' + CHECKIN_COLS).in('enrolment_id', ids).gte('day', addDays(today, -7)),
    db.from('maktoub_lumi_wins').select('enrolment_id,quote').in('enrolment_id', ids).eq('said_on', today),
    db.from('maktoub_lumi_notes').select('id,enrolment_id,note,urgent').in('enrolment_id', ids).is('digested_at', null),
    db.from('maktoub_lumi_weekly').select('enrolment_id,summary').in('enrolment_id', ids).eq('status', 'approved').gte('decided_at', new Date(Date.now() - 86400e3).toISOString()),
  ])
  const lines: string[] = [`<b>Lumi · ${today}</b>`]
  for (const en of (ens.data || []).filter(e => !['completed', 'cancelled'].includes(e.stage))) {
    const mine = (cks.data || []).filter((c: Row) => c.enrolment_id === en.id) as Row[]
    const t = mine.find(c => c.day === today)
    const last = mine.map(c => c.day).sort().pop()
    const gap = last ? Math.round((Date.parse(today) - Date.parse(last)) / 86400e3) : null
    const prev = mine.filter(c => c.day !== today && c.mood)
    const avgMood = prev.length ? prev.reduce((s, c) => s + c.mood, 0) / prev.length : null
    const flags: string[] = []
    if (en.stage === 'active' && (gap === null || gap >= 3)) flags.push(gap === null ? 'no check-ins yet' : `${gap} days without a check-in`)
    if (t?.mood && avgMood && t.mood <= avgMood - 3) flags.push(`mood ${t.mood} (usually ${avgMood.toFixed(0)})`)
    if (t?.energy && t.energy <= 3) flags.push(`energy ${t.energy}`)
    const name = `${esc(firstName(en))} · ${esc(en.reference_code)}${en.is_test ? ' · TEST' : ''}`
    const today_ = t ? [t.sleep_hours != null && `sleep ${t.sleep_hours}h`, t.trained != null && (t.trained ? 'trained' : 'no training'), t.energy && `energy ${t.energy}`, t.mood && `mood ${t.mood}`, t.stress && `stress ${t.stress}`, t.protocol_done && `protocol ${t.protocol_done}`].filter(Boolean).join(', ') : 'no check-in today'
    lines.push(`\n${flags.length ? '⚠️ ' : ''}<b>${name}</b>\n${esc(today_)}${flags.length ? `\n${esc(flags.join(' · '))}` : ''}`)
    for (const n of (notes.data || []).filter(n => n.enrolment_id === en.id)) lines.push(`${n.urgent ? '⚠️ Flagged' : '✉️ Asked to pass on'}: ${esc(n.note)}`)
    for (const w of (wins.data || []).filter(w => w.enrolment_id === en.id)) lines.push(`✨ “${esc(w.quote)}”`)
    for (const s of (weeks.data || []).filter(s => s.enrolment_id === en.id)) lines.push(`📄 Weekly summary approved:\n${esc(s.summary)}`)
  }
  let msg = lines.join('\n')
  if (msg.length > 3900) msg = msg.slice(0, 3850) + '\n…\nThe rest is in the console.'
  if (await alertFounder(msg, `${SITE}/lumi/#checkins`) && notes.data?.length)
    await db.from('maktoub_lumi_notes').update({ digested_at: new Date().toISOString() }).in('id', notes.data.map(n => n.id))
}

async function tick() {
  if (!LUMI_BOT || !claude) return { skipped: 'not connected' }
  const started = Date.now()
  const { data: links } = await db.from('maktoub_lumi_links').select('*').not('tg_chat_id', 'is', null)
  const done: string[] = []
  for (const link of links || []) {
    if (Date.now() - started > 100e3) break
    const en = await enrolment(link.enrolment_id)
    if (!usable(en) || !NUDGE_STAGES.has(en!.stage) || !link.nudges_on || !(await consented(en!.id))) continue
    const L = localNow(en!.timezone || TZ)
    try {
      if (L.hm >= String(link.nudge_time).slice(0, 5) && link.last_nudge_day !== L.date) {
        // Claim the day first so overlapping runs never send twice.
        const { data: claimed } = await db.from('maktoub_lumi_links').update({ last_nudge_day: L.date }).eq('enrolment_id', link.enrolment_id)
          .or(`last_nudge_day.is.null,last_nudge_day.neq.${L.date}`).select('enrolment_id')
        if (claimed?.length) {
          if (L.dow === 'Fri') { await weekly(en!, link, L.date); done.push('weekly') }
          else {
            const { data: has } = await db.from('maktoub_lumi_checkins').select('id').eq('enrolment_id', en!.id).eq('day', L.date).maybeSingle()
            if (!has) { await nudge(en!, link); done.push('nudge') }
          }
        }
      }
      const nextSpark = () => new Date(Date.now() + (30 + Math.random() * 50) * 3600e3).toISOString()
      if (!link.next_spark_at) await db.from('maktoub_lumi_links').update({ next_spark_at: nextSpark() }).eq('enrolment_id', link.enrolment_id)
      else if (Date.parse(link.next_spark_at) <= Date.now() && L.hour >= 10 && L.hour < 20) {
        const { data: claimed } = await db.from('maktoub_lumi_links').update({ next_spark_at: nextSpark() }).eq('enrolment_id', link.enrolment_id).eq('next_spark_at', link.next_spark_at).select('enrolment_id')
        if (claimed?.length) { await spark(en!, link); done.push('spark') }
      }
    } catch (e) { console.error('lumi tick failed for one client', (e as Error).message) }
  }
  const R = localNow(TZ)
  if (R.hour >= 22 && (await config('lumi_digest_day')) !== R.date) {
    await db.from('maktoub_internal_config').upsert({ key: 'lumi_digest_day', value: R.date }, { onConflict: 'key' })
    await digest(R.date); done.push('digest')
  }
  return { done }
}

// ---------- Telegram webhook ----------
const HELP = `I’m Lumi. Just talk to me about your day and I’ll keep your check-in.

/time 21:30 sets when I check in each evening
/quiet pauses my messages, /resume turns them back on
/share on or /share off lets the Maktoub team read our conversations, or not
/unlink disconnects Telegram`

async function telegramUpdate(u: Row) {
  if (u.callback_query) return weeklyDecision(u.callback_query)
  const m = u.message
  if (!m?.chat || !m.from || m.from.is_bot) return
  if (m.chat.type === 'private') return privateMessage(m)
  if (m.chat.type === 'group' || m.chat.type === 'supergroup') return groupMessage(m)
}

async function privateMessage(m: Row) {
  const chatId = m.chat.id, text = typeof m.text === 'string' ? m.text.trim() : ''
  const startCode = /^\/start\s+([0-9a-f]{32})$/i.exec(text)?.[1]
  if (startCode) {
    const { data: link } = await db.from('maktoub_lumi_links').select('*').eq('link_code_hash', await sha256(startCode.toLowerCase())).maybeSingle()
    if (!link || !link.link_code_expires_at || Date.parse(link.link_code_expires_at) < Date.now()) { await sayTo(chatId, 'This link has expired. Open Lumi in your Maktoub portal and tap “Connect Telegram” again.'); return }
    const { data: other } = await db.from('maktoub_lumi_links').select('enrolment_id').or(`tg_user_id.eq.${m.from.id},tg_chat_id.eq.${chatId}`).neq('enrolment_id', link.enrolment_id).maybeSingle()
    if (other) { await sayTo(chatId, 'This Telegram account is already connected to another Maktoub programme. Please contact the Maktoub team.'); return }
    const en = await enrolment(link.enrolment_id)
    const L = localNow(en?.timezone || TZ)
    // No evening nudge on the day they connect if the hour has already passed: the welcome is enough.
    const skipToday = L.hm >= String(link.nudge_time).slice(0, 5)
    await db.from('maktoub_lumi_links').update({ tg_user_id: m.from.id, tg_chat_id: chatId, tg_username: m.from.username || null, linked_at: new Date().toISOString(), link_code_hash: null, link_code_expires_at: null, ...(skipToday ? { last_nudge_day: L.date } : {}) }).eq('enrolment_id', link.enrolment_id)
    logEvent(link.enrolment_id, 'client', 'lumi_telegram_linked')
    await sayTo(chatId, `Hello ${en ? firstName(en) : ''}. I’m Lumi, and I’m here now too.\n\nEach evening at ${String(link.nudge_time).slice(0, 5)} I’ll check in on your day; tell me as much or as little as you like and I’ll keep your check-in for you. Send /help any time.`)
    return
  }
  const { data: link } = await db.from('maktoub_lumi_links').select('*').eq('tg_chat_id', chatId).maybeSingle()
  if (!link) { await sayTo(chatId, 'I’m Lumi, Maktoub’s private AI. I only talk with Maktoub clients: open Lumi in your private portal and tap “Connect Telegram”.'); return }
  const en = await enrolment(link.enrolment_id)
  if (!usable(en)) { await sayTo(chatId, 'Your Lumi access has ended. Thank you for the time we had.'); return }
  if (!(await consented(en!.id))) { await sayTo(chatId, 'Please open Lumi in your Maktoub portal once and read the short notice there before we continue.'); return }
  if (!text) { await sayTo(chatId, 'I can only read text messages for now.'); return }

  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '')
  const arg = text.slice(text.split(/\s+/)[0].length).trim().toLowerCase()
  if (cmd === '/start' || cmd === '/help') { await sayTo(chatId, HELP); return }
  if (cmd === '/time') {
    const mt = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(arg)
    if (!mt) { await sayTo(chatId, 'Send the time like this: /time 21:30'); return }
    const hm = `${mt[1].padStart(2, '0')}:${mt[2]}`
    await db.from('maktoub_lumi_links').update({ nudge_time: hm }).eq('enrolment_id', en!.id)
    await sayTo(chatId, `Done. I’ll check in each evening at ${hm}.`); return
  }
  if (cmd === '/quiet' || cmd === '/resume') {
    await db.from('maktoub_lumi_links').update({ nudges_on: cmd === '/resume' }).eq('enrolment_id', en!.id)
    await sayTo(chatId, cmd === '/quiet' ? 'I’ll stay quiet until you send /resume. You can still write to me any time.' : 'Welcome back. I’ll check in again this evening.'); return
  }
  if (cmd === '/share') {
    if (arg !== 'on' && arg !== 'off') { await sayTo(chatId, `Sharing is ${link.share_conversations ? 'on' : 'off'}. Send /share on or /share off.`); return }
    await db.from('maktoub_lumi_links').update({ share_conversations: arg === 'on', share_changed_at: new Date().toISOString() }).eq('enrolment_id', en!.id)
    logEvent(en!.id, 'client', arg === 'on' ? 'lumi_sharing_on' : 'lumi_sharing_off')
    await sayTo(chatId, arg === 'on' ? 'The Maktoub team can now read our conversations. Send /share off whenever you like.' : 'Our conversations are private again. The team still sees your check-ins.'); return
  }
  if (cmd === '/unlink') {
    await db.from('maktoub_lumi_links').update({ tg_user_id: null, tg_chat_id: null, tg_username: null, linked_at: null }).eq('enrolment_id', en!.id)
    logEvent(en!.id, 'client', 'lumi_telegram_unlinked')
    await sayTo(chatId, 'Disconnected. You can still talk to me in your portal, and reconnect from there any time.'); return
  }
  if (text.startsWith('/')) { await sayTo(chatId, HELP); return }

  const who = 'c:' + en!.id
  if (await limited('cmp-h:' + who, 40, 3600) || await limited('cmp-d:' + who, 150, 86400)) { await sayTo(chatId, 'That is a lot for one sitting. Let’s pick this up a little later.'); return }
  const t = await weekThread(en!, 'telegram')
  const { data: dup } = await db.from('maktoub_companion_messages').select('id').eq('thread_id', t.id).eq('tg_message_id', m.message_id).maybeSingle()
  if (dup) return
  lumiTg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  try {
    const r = await runTurn(t, [{ type: 'text', text: clientSystem(en!.addressed_as) }, { type: 'text', text: t.context_snapshot }], text.slice(0, MAX_TEXT), {
      en: en!, source: 'telegram', tgMessageId: m.message_id, effort: 'medium', maxTokens: 4000,
    })
    await sayTo(chatId, r.refused ? 'I can’t help with that one. Could you put it another way?' : r.text || 'I’ve noted that.')
  } catch (e) { await sayTo(chatId, modelErrorText(e)) }
}

async function groupMessage(m: Row) {
  const chatId = m.chat.id, text = typeof m.text === 'string' ? m.text.trim() : ''
  if (!text) return
  const me = await lumiBot()
  const isFounder = String(m.from.id) === String(FOUNDER_CHAT)
  const linkCmd = /^\/link(?:@\w+)?\s+(RP-[0-9A-Z]{6})$/i.exec(text)
  if (linkCmd || /^\/unlink(?:@\w+)?$/i.test(text)) {
    if (!isFounder) return
    if (!linkCmd) {
      await db.from('maktoub_lumi_links').update({ group_chat_id: null, group_linked_at: null }).eq('group_chat_id', chatId)
      await lumiTg('sendMessage', { chat_id: chatId, text: 'I’ve left this conversation. Goodbye for now.' }); return
    }
    const { data: en } = await db.from('maktoub_enrolments').select('*').eq('reference_code', linkCmd[1].toUpperCase()).maybeSingle()
    const link = en ? await linkOf(en.id) : null
    if (!en || !usable(en) || !link?.tg_user_id || !(await consented(en.id))) { await lumiTg('sendMessage', { chat_id: chatId, text: 'That client needs to accept Lumi’s notice and connect Telegram first.' }); return }
    const member = await lumiTg('getChatMember', { chat_id: chatId, user_id: link.tg_user_id }).catch(() => null)
    if (!member || ['left', 'kicked'].includes(member.status)) { await lumiTg('sendMessage', { chat_id: chatId, text: 'Please add the client to this group first, then send /link again.' }); return }
    await db.from('maktoub_lumi_links').update({ group_chat_id: chatId, group_linked_at: new Date().toISOString() }).eq('enrolment_id', en.id)
    logEvent(en.id, 'founder', 'lumi_group_linked')
    await lumiTg('sendMessage', { chat_id: chatId, text: `Hello both. I’m here for ${firstName(en)}. Start a message with “Lumi” or reply to me and I’ll join in.` }); return
  }
  const { data: link } = await db.from('maktoub_lumi_links').select('*').eq('group_chat_id', chatId).maybeSingle()
  if (!link) return
  const addressed = /^lumi\b/i.test(text) || /^\/lumi\b/i.test(text) || (me && text.includes('@' + me.username)) || (me && m.reply_to_message?.from?.id === me.id)
  const speaker = isFounder ? 'founder' : m.from.id === link.tg_user_id ? 'client' : null
  if (!addressed || !speaker) return
  const en = await enrolment(link.enrolment_id)
  if (!usable(en) || !(await consented(en!.id))) return
  if (await limited('cmp-g:' + en!.id, 60, 3600)) return
  const t = await weekThread(en!, 'group')
  const { data: dup } = await db.from('maktoub_companion_messages').select('id').eq('thread_id', t.id).eq('tg_message_id', m.message_id).maybeSingle()
  if (dup) return
  const clean = text.replace(/^\/lumi(?:@\w+)?\s*/i, '').replace(me ? new RegExp('@' + me.username, 'g') : /$^/, '').trim()
  lumiTg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  try {
    const r = await runTurn(t, [{ type: 'text', text: clientSystem(en!.addressed_as) + GROUP_ADDENDUM }, { type: 'text', text: t.context_snapshot }], clean.slice(0, MAX_TEXT) || '(no text)', {
      en: en!, source: 'group', speaker, labels: { client: firstName(en!), founder: 'Founder' }, tgMessageId: m.message_id, effort: 'medium', maxTokens: 4000,
    })
    if (!r.refused && r.text) await sayTo(chatId, r.text, { reply_parameters: { message_id: m.message_id } })
  } catch (e) { await sayTo(chatId, modelErrorText(e)) }
}

async function weeklyDecision(q: Row) {
  const mt = /^wk:([ad]):([0-9a-f-]{36})$/.exec(String(q.data || ''))
  const answer = (text: string) => lumiTg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {})
  if (!mt) return answer('')
  const { data: wk } = await db.from('maktoub_lumi_weekly').select('*').eq('id', mt[2]).maybeSingle()
  const link = wk ? await linkOf(wk.enrolment_id) : null
  if (!wk || !link || link.tg_user_id !== q.from?.id) return answer('This is not yours to decide.')
  if (wk.status !== 'draft') return answer(wk.status === 'approved' ? 'Already sent.' : 'Already kept private.')
  const approved = mt[1] === 'a'
  await db.from('maktoub_lumi_weekly').update({ status: approved ? 'approved' : 'declined', decided_at: new Date().toISOString() }).eq('id', wk.id)
  logEvent(wk.enrolment_id, 'client', approved ? 'lumi_weekly_approved' : 'lumi_weekly_declined', { week_start: wk.week_start })
  await answer(approved ? 'Sent to the Maktoub team.' : 'Kept private.')
  if (q.message) lumiTg('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: approved ? '✓ Sent to the team' : '✓ Kept private', callback_data: 'wk:done' }]] } }).catch(() => {})
}

// ---------- web actions ----------
async function clientTelegramState(en: Row) {
  const link = await linkOf(en.id)
  const me = LUMI_BOT ? await lumiBot().catch(() => null) : null
  return {
    available: !!me, bot: me?.username || null,
    linked: !!link?.tg_chat_id, username: link?.tg_username || null, group: !!link?.group_chat_id,
    nudge_time: link ? String(link.nudge_time).slice(0, 5) : '21:00', nudges_on: link ? link.nudges_on : true,
    share: !!link?.share_conversations,
  }
}

async function handle(c: Caller, body: Row, origin: string, req: Request, ip: string) {
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
    const res: Row = { connected: !!claude, threads: await listThreads(c) }
    if (c.kind === 'client') Object.assign(res, { consented: await consented(c.en.id), notice: NOTICE, notice_version: NOTICE_VERSION, first_name: firstName(c.en), telegram: await clientTelegramState(c.en) })
    else {
      const { data } = await db.from('maktoub_enrolments').select('id,reference_code,invited_name,intake->>preferred_name,stage,is_test')
        .is('revoked_at', null).neq('stage', 'cancelled').order('created_at', { ascending: false }).limit(300)
      res.clients = (data || []).map(r => ({ id: r.id, reference: r.reference_code, name: r.invited_name, stage: r.stage, test: r.is_test }))
      const me = LUMI_BOT ? await lumiBot().catch(() => null) : null
      const hook = me ? await lumiTg('getWebhookInfo', {}).catch(() => null) : null
      res.bot = { configured: !!LUMI_BOT, username: me?.username || null, connected: !!hook?.url && hook.url === FN_URL, founder_bot: !!FOUNDER_BOT }
    }
    return json(res, 200, origin)
  }

  // ----- client: Telegram and sharing -----
  if (c.kind === 'client' && action === 'tg_link') {
    const me = LUMI_BOT ? await lumiBot() : null
    if (!me) throw new HttpError(409, 'Telegram is not ready yet.')
    const code = randomHex(16)
    await db.from('maktoub_lumi_links').upsert({ enrolment_id: c.en.id, link_code_hash: await sha256(code), link_code_expires_at: new Date(Date.now() + 30 * 60e3).toISOString() }, { onConflict: 'enrolment_id' })
    return json({ url: `https://t.me/${me.username}?start=${code}` }, 200, origin)
  }
  if (c.kind === 'client' && action === 'tg_unlink') {
    const link = await linkOf(c.en.id)
    if (link?.tg_chat_id) sayTo(link.tg_chat_id, 'Disconnected from your portal. Reconnect from there any time.').catch(() => {})
    await db.from('maktoub_lumi_links').update({ tg_user_id: null, tg_chat_id: null, tg_username: null, linked_at: null }).eq('enrolment_id', c.en.id)
    logEvent(c.en.id, 'client', 'lumi_telegram_unlinked')
    return json({ telegram: await clientTelegramState(c.en) }, 200, origin)
  }
  if (c.kind === 'client' && action === 'prefs') {
    const changes: Row = {}
    if (typeof body.share === 'boolean') { changes.share_conversations = body.share; changes.share_changed_at = new Date().toISOString(); logEvent(c.en.id, 'client', body.share ? 'lumi_sharing_on' : 'lumi_sharing_off') }
    if (typeof body.nudges_on === 'boolean') changes.nudges_on = body.nudges_on
    if (typeof body.nudge_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.nudge_time)) changes.nudge_time = body.nudge_time
    if (Object.keys(changes).length) await db.from('maktoub_lumi_links').upsert({ enrolment_id: c.en.id, ...changes }, { onConflict: 'enrolment_id' })
    return json({ telegram: await clientTelegramState(c.en) }, 200, origin)
  }

  // ----- founder: overview, shared conversations, bot connection -----
  if (c.kind === 'founder' && action === 'checkins') {
    const today = localNow(TZ).date
    const { data: links } = await db.from('maktoub_lumi_links').select('enrolment_id,tg_chat_id,group_chat_id,share_conversations,nudges_on,nudge_time')
    const { data: withData } = await db.from('maktoub_lumi_checkins').select('enrolment_id').gte('day', addDays(today, -30))
    const ids = [...new Set([...(links || []).map(l => l.enrolment_id), ...(withData || []).map(r => r.enrolment_id)])]
    if (!ids.length) return json({ clients: [], today }, 200, origin)
    const [ens, cks, wins, notes, weeks] = await Promise.all([
      db.from('maktoub_enrolments').select('id,reference_code,invited_name,intake->>preferred_name,stage,is_test,start_date').in('id', ids),
      db.from('maktoub_lumi_checkins').select('enrolment_id,source,' + CHECKIN_COLS).in('enrolment_id', ids).gte('day', addDays(today, -13)).order('day', { ascending: false }),
      db.from('maktoub_lumi_wins').select('enrolment_id,quote,said_on').in('enrolment_id', ids).order('said_on', { ascending: false }).limit(200),
      db.from('maktoub_lumi_notes').select('enrolment_id,note,urgent,created_at').in('enrolment_id', ids).order('created_at', { ascending: false }).limit(200),
      db.from('maktoub_lumi_weekly').select('enrolment_id,week_start,week_end,summary,decided_at').in('enrolment_id', ids).eq('status', 'approved').order('week_start', { ascending: false }).limit(100),
    ])
    const clients = (ens.data || []).map(en => {
      const l = (links || []).find(x => x.enrolment_id === en.id)
      return {
        id: en.id, reference: en.reference_code, name: en.invited_name, stage: en.stage, test: en.is_test,
        telegram: !!l?.tg_chat_id, group: !!l?.group_chat_id, share: !!l?.share_conversations, nudges_on: l?.nudges_on ?? null, nudge_time: l ? String(l.nudge_time).slice(0, 5) : null,
        checkins: (cks.data || []).filter((x: Row) => x.enrolment_id === en.id),
        wins: (wins.data || []).filter(x => x.enrolment_id === en.id).slice(0, 10),
        notes: (notes.data || []).filter(x => x.enrolment_id === en.id).slice(0, 10),
        weekly: (weeks.data || []).filter(x => x.enrolment_id === en.id).slice(0, 4),
      }
    })
    return json({ clients, today }, 200, origin)
  }
  if (c.kind === 'founder' && action === 'client_conversations') {
    if (typeof body.enrolment_id !== 'string' || !UUID.test(body.enrolment_id)) throw new HttpError(400, 'Choose a client.')
    const link = await linkOf(body.enrolment_id)
    const rooms = link?.share_conversations ? ['self', 'telegram', 'group'] : ['group']
    const { data: threads } = await db.from('maktoub_companion_threads').select('id,room,title,updated_at').eq('owner', 'client').eq('enrolment_id', body.enrolment_id).in('room', rooms).order('updated_at', { ascending: false }).limit(20)
    const out = []
    for (const t of threads || []) {
      const { data: msgs } = await db.from('maktoub_companion_messages').select('role,text,kind,speaker,created_at').eq('thread_id', t.id).neq('text', '').order('id')
      out.push({ ...t, messages: (msgs || []).map(m => ({ role: m.kind === 'outbound' ? 'assistant' : m.role, speaker: m.speaker, text: m.text, created_at: m.created_at })) })
    }
    logEvent(body.enrolment_id, 'founder', 'lumi_conversations_read', { shared: !!link?.share_conversations, threads: out.length })
    return json({ shared: !!link?.share_conversations, threads: out }, 200, origin)
  }
  if (c.kind === 'founder' && action === 'connect_bot') {
    if (!LUMI_BOT) throw new HttpError(409, 'Add the MAKTOUB_LUMI_BOT_TOKEN secret first.')
    const secret = await config('lumi_tg_secret')
    if (!secret) throw new HttpError(409, 'Run the Lumi Telegram migration first.')
    await lumiTg('setWebhook', { url: FN_URL, secret_token: secret, allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: true })
    await lumiTg('setMyCommands', { commands: [
      { command: 'help', description: 'What Lumi can do' }, { command: 'time', description: 'Set your evening check-in time, e.g. /time 21:30' },
      { command: 'quiet', description: 'Pause Lumi’s messages' }, { command: 'resume', description: 'Turn Lumi’s messages back on' },
      { command: 'share', description: 'Share conversations with the team: /share on or /share off' }, { command: 'unlink', description: 'Disconnect Telegram' },
    ] })
    await lumiTg('setMyDescription', { description: 'Lumi is Maktoub’s private AI for clients of The Readiness Programme. Connect from your private portal.' }).catch(() => {})
    return json({ connected: true }, 200, origin)
  }

  // ----- conversations -----
  if (action === 'open') {
    let row: Row
    if (c.kind === 'client') {
      row = { owner: 'client', room: 'self', enrolment_id: c.en.id, context_snapshot: await clientSelfSnapshot(c.en), context_read_at: new Date().toISOString() }
    } else if (body.room === 'client') {
      if (typeof body.enrolment_id !== 'string' || !UUID.test(body.enrolment_id)) throw new HttpError(400, 'Choose a client.')
      const en = await enrolment(body.enrolment_id)
      if (!en) throw new HttpError(404, 'Client not found.')
      const snap = await founderClientSnapshot(en)
      row = { owner: 'founder', room: 'client', founder_uid: c.uid, enrolment_id: en.id, context_snapshot: snap.text, context_read_at: new Date().toISOString(), title: `${firstName(en)} · ${en.reference_code}` }
      logEvent(en.id, 'founder', 'lumi_record_read', { scope: snap.scope })
    } else {
      row = { owner: 'founder', room: 'private', founder_uid: c.uid }
    }
    const { data, error } = await db.from('maktoub_companion_threads').insert(row).select(THREAD_COLS).single()
    if (error) throw error
    return json({ thread: data }, 200, origin)
  }

  if (action === 'get') {
    const t = await ownThread(c, body.thread_id)
    const { data, error } = await db.from('maktoub_companion_messages').select('role,text,kind,speaker,created_at').eq('thread_id', t.id).neq('text', '').order('id')
    if (error) throw error
    return json({ thread: { id: t.id, room: t.room, title: t.title, context_read_at: t.context_read_at }, messages: (data || []).map(m => ({ role: m.kind === 'outbound' ? 'assistant' : m.role, speaker: m.speaker, text: m.text, created_at: m.created_at })) }, 200, origin)
  }

  if (action === 'send') {
    const t = await ownThread(c, body.thread_id)
    if (t.room === 'telegram' || t.room === 'group') throw new HttpError(409, 'Telegram conversations continue in Telegram.')
    const text = str(body.text, MAX_TEXT)
    if (!text) throw new HttpError(400, 'Write something first.')
    const [hour, day] = c.kind === 'founder' ? [200, 1500] : [40, 150]
    if (await limited('cmp-h:' + who, hour, 3600) || await limited('cmp-d:' + who, day, 86400)) throw new HttpError(429, 'That is a lot of conversation for one sitting. Please come back a little later.')
    return streamTurn(c, t, text, origin)
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
    if (t.room === 'group') throw new HttpError(409, 'The group conversation is shared with the team and cannot be deleted from here.')
    const { error } = await db.from('maktoub_companion_threads').delete().eq('id', t.id)
    if (error) throw error
    if (c.kind === 'client') logEvent(c.en.id, 'client', 'lumi_thread_deleted', { room: t.room })
    return json({ success: true }, 200, origin)
  }

  throw new HttpError(400, 'Unknown action.')
}

Deno.serve(async (req) => {
  // Scheduler (pg_cron) and Telegram arrive without a browser origin and carry their own secrets.
  if (req.headers.has('x-lumi-cron')) {
    const secret = await config('lumi_cron_secret')
    if (!secret || req.headers.get('x-lumi-cron') !== secret) return new Response('forbidden', { status: 403 })
    try { return Response.json(await tick()) } catch (e) { console.error('lumi tick error', (e as Error).message); return Response.json({ error: true }, { status: 500 }) }
  }
  if (req.headers.has('x-telegram-bot-api-secret-token')) {
    const secret = await config('lumi_tg_secret')
    if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret || !LUMI_BOT) return new Response('forbidden', { status: 403 })
    // Always 200, so Telegram never redelivers; duplicates are dropped by message id anyway.
    try { await telegramUpdate(await req.json()) } catch (e) { console.error('lumi telegram error', (e as Error).message) }
    return new Response('ok')
  }
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
