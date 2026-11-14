// Maktoub programmes (first: The Readiness Programme, readiness-90).
//
// Three doors, one function:
//   1. Client  — maktoub.app/ready/?invite=TOKEN. Gated by the invite token (only its SHA-256 is stored).
//   2. Founder — maktoub.app/ready/admin/. Gated by a Supabase session whose user is a founder in maktoub_admins.
//   3. Telegram — the founder's bot webhook. Gated by Telegram's secret-token header AND the founder's chat id.
//      "/ready Anas +9665…" creates a private invitation and replies with the link, on the spot.
//
// Isolation: separate tables (maktoub_enrolments…), separate private bucket, no changes to maktoub-onboard.
// Medical privacy: this function never accepts medical files. Only a clearance status and short,
// non-diagnostic constraints are stored. The intake asks for limitations "in your own words".
import { createClient } from 'npm:@supabase/supabase-js@2'
import { parsePhoneNumberFromString } from 'npm:libphonenumber-js@1.11.20'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const ORIGINS = new Set(['https://maktoub.app', 'https://www.maktoub.app'])
const SITE = 'https://maktoub.app'
const BUCKET = 'maktoub-programme'
const TOKEN_RE = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_AUDIO = 25 * 1024 * 1024
const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
}
const BOT = ['MAKTOUB_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN', 'TG_BOT_TOKEN', 'BOT_TOKEN'].map(n => Deno.env.get(n)).find(Boolean) || ''
const FOUNDER_CHAT = Deno.env.get('MAKTOUB_TELEGRAM_CHAT_ID') || '970663486'
const REQUIRED_DOCS = ['programme_agreement', 'programme_terms', 'medical_disclaimer', 'health_consent', 'digital_consent']
const DOC_ORDER = [...REQUIRED_DOCS, 'programme_voice']
const PREP_STAGES = ['payment_verified', 'meeting_pending', 'meeting_completed', 'medical_pending', 'baseline', 'protocol_preparing', 'bot_configuration', 'portal_ready', 'start_confirmed']
const STAGE_LABELS: Record<string, string> = {
  invited: 'Proposal sent', signed: 'Agreement signed', payment_reported: 'Transfer reported',
  payment_verified: 'Payment verified', meeting_pending: 'Planning meeting pending', meeting_completed: 'Planning meeting completed',
  medical_pending: 'Medical check-in pending', baseline: 'Movement and nutrition baseline', protocol_preparing: 'Protocol in preparation',
  bot_configuration: 'Telegram configuration', portal_ready: 'Portal ready', start_confirmed: 'Start date confirmed',
  active: 'Programme active', paused: 'Paused', completed: 'Programme completed', cancelled: 'Cancelled',
}
const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']

// ---------- utilities ----------
const corsHeaders = (o: string | null): HeadersInit => ({
  'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'Cache-Control': 'no-store',
  ...(o && ORIGINS.has(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' } : {}),
})
const json = (b: unknown, s: number, o: string | null) => new Response(JSON.stringify(b), { status: s, headers: corsHeaders(o) })
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const riyadhDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10)
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3)

async function limited(key: string, max: number, secs: number) {
  const { data, error } = await db.rpc('maktoub_rate_hit', { p_key: await sha256(key), p_max: max, p_window_seconds: secs })
  if (error) { console.error('rate limit check failed', error.message); return false }
  return data === false
}
const logEvent = (enrolment_id: string, actor: 'client' | 'founder' | 'system' | 'telegram', action: string, detail: Record<string, unknown> = {}) =>
  db.from('maktoub_enrolment_events').insert({ enrolment_id, actor, action, detail }).then(({ error }) => { if (error) console.error('event log failed', error.message) })

async function telegram(method: string, payload: Record<string, unknown>) {
  if (!BOT) throw new Error('no bot token')
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.ok) throw new Error(`telegram ${method} ${r.status} ${String(j.description || '').slice(0, 120)}`)
  return j.result
}
// Founder alert. Operational only; never includes intake answers or health information.
async function alertFounder(en: Record<string, any>, title: string, extra = '') {
  if (en.is_test || !BOT) return
  const name = en.intake?.full_name || en.signature_name || en.invited_name
  const text = `<b>${esc(title)}</b>\nReadiness · ${esc(name)} · ${esc(en.reference_code)}\n📱 ${esc(en.invited_phone)}${extra ? '\n' + esc(extra) : ''}`
  try {
    await telegram('sendMessage', { chat_id: FOUNDER_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: 'Open record', url: `${SITE}/ready/admin/#${en.id}` }]] } })
    logEvent(en.id, 'system', 'founder_alerted', { title })
  } catch (e) { console.error('founder alert failed', (e as Error).message); logEvent(en.id, 'system', 'founder_alert_failed', { title }) }
}

// ---------- programme, settings, documents ----------
async function bankSettings() {
  const { data, error } = await db.from('maktoub_onboarding_settings').select('provider_legal_name,provider_registration,bank_account_name,bank_name,bank_iban,bank_swift,bank_verified_at').eq('id', true).single()
  if (error || !data) throw new Error('settings unavailable')
  return data
}
async function programme(code: string) {
  const { data, error } = await db.from('maktoub_programmes').select('*').eq('code', code).single()
  if (error || !data) throw new Error('programme unavailable')
  return data
}
const bankReady = (s: Record<string, any>) => !!(s.bank_verified_at && s.bank_account_name && s.bank_name && s.bank_iban)
const readyForReal = (p: Record<string, any>, s: Record<string, any>) => bankReady(s) && !!s.provider_legal_name && !!p.documents_approved_at

async function documents(p: Record<string, any>, s: Record<string, any>, price: { minor: number; currency: string }) {
  const versions = Object.values(p.documents || {}) as string[]
  const { data, error } = await db.from('maktoub_legal_documents').select('version,kind,title,body').in('version', versions)
  if (error || !data || data.length !== versions.length) throw new Error('legal documents unavailable')
  const fill = (b: string) => b.replaceAll('{{PROVIDER}}', s.provider_legal_name || 'Maktoub')
    .replaceAll('{{FEE}}', money(price.minor, price.currency))
    .replaceAll('{{VOICE_FEE}}', p.voice_addon_minor ? money(p.voice_addon_minor, p.currency) : 'the agreed fee')
    .replaceAll('{{SESSIONS}}', NUMBER_WORDS[p.live_sessions] || String(p.live_sessions)).trim()
  return Promise.all(data.sort((a, b) => DOC_ORDER.indexOf(a.kind) - DOC_ORDER.indexOf(b.kind)).map(async d => {
    const body = fill(d.body)
    return { kind: d.kind, version: d.version, title: d.title, body, optional: d.kind === 'programme_voice', sha256: await sha256(d.version + '\n' + d.title + '\n' + body) }
  }))
}

// ---------- advanced intake (one schema: validates here, renders in the portal) ----------
// Founder-designed (14 Nov 2026), adapted from the founder's therapy intake for a mind-and-body programme.
// Clinical detail (diagnoses, medication names, reports, bowel/urinary/sexual specifics) belongs with the
// client's own physician; here we ask only what the plan must work around.
type F = { k: string; t: 'text' | 'long' | 'email' | 'date' | 'time' | 'number' | 'score' | 'choice' | 'multi' | 'bool'; l: string; h?: string; o?: string[]; min?: number; max?: number; step?: number; unit?: string; lo?: string; hi?: string; req?: boolean; n?: string }
const YN = ['Yes', 'No']
const INTAKE: { id: string; title: string; intro: string; fields: F[] }[] = [
  { id: 'you', title: 'You', intro: 'The essentials. Your mobile number is already on file.', fields: [
    { k: 'full_name', t: 'text', l: 'Full name, including family name', n: 'your full name', req: true, max: 150 },
    { k: 'preferred_name', t: 'text', l: 'What should we call you?', max: 60 },
    { k: 'email', t: 'email', l: 'Email', n: 'your email', h: 'For your portal and programme documents.', req: true },
    { k: 'dob', t: 'date', l: 'Date of birth', n: 'your date of birth', req: true },
    { k: 'birth_time', t: 'time', l: 'Time of birth', h: 'If known.' },
    { k: 'birth_place', t: 'text', l: 'Place of birth', h: 'City and country, if known.', max: 120 },
    { k: 'address', t: 'text', l: 'Where you live', h: 'City and area is enough.', max: 200 },
    { k: 'occupation', t: 'text', l: 'What you do', max: 150 },
    { k: 'timezone', t: 'choice', l: 'Your time zone', o: ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Bahrain', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Toronto', 'Other'] },
    { k: 'family_situation', t: 'multi', l: 'Family situation', h: 'Select all that apply.', o: ['Single', 'Married', 'Separated or divorcing', 'In a relationship', 'Have children', 'Family life is stressful right now'] },
    { k: 'family_note', t: 'long', l: 'Anything about your situation at home we should know?', max: 2000 },
  ] },
  { id: 'transition', title: 'The transition', intro: 'What is changing, and what you want from it.', fields: [
    { k: 'coached_before', t: 'choice', l: 'Have you done coaching or therapy before?', o: YN },
    { k: 'transition_context', t: 'long', l: 'What is changing in your life right now?', max: 4000 },
    { k: 'transition_since', t: 'text', l: 'When did this period begin?', max: 120 },
    { k: 'goal_1', t: 'text', l: 'Goal one', n: 'at least one goal', h: 'Your top three goals for the 90 days.', req: true, max: 300 },
    { k: 'goal_2', t: 'text', l: 'Goal two', max: 300 },
    { k: 'goal_3', t: 'text', l: 'Goal three', max: 300 },
    { k: 'magic_change', t: 'long', l: 'If you could change one thing in your life overnight, what would it be?', max: 2000 },
    { k: 'impact_thoughts', t: 'score', l: 'How much is this period affecting your thoughts?', min: 0, lo: 'Not at all', hi: 'Completely' },
    { k: 'impact_feelings', t: 'score', l: '… your feelings?', min: 0, lo: 'Not at all', hi: 'Completely' },
    { k: 'impact_body', t: 'score', l: '… your body and health?', min: 0, lo: 'Not at all', hi: 'Completely' },
    { k: 'why_now', t: 'long', l: 'Why do you want to address this now? How is it affecting your life?', max: 3000 },
    { k: 'past_efforts', t: 'long', l: 'What have you tried before, and what happened?', max: 3000 },
    { k: 'biggest_obstacle', t: 'long', l: 'What is the biggest obstacle between you and the outcome you want?', max: 2000 },
    { k: 'desired_outcome', t: 'long', l: 'Day 90. Describe yourself in positive terms.', n: 'your day-90 outcome', h: 'For example: disciplined, calm under pressure, strong, sleeping well.', req: true, max: 3000 },
  ] },
  { id: 'mind', title: 'Mind', intro: 'Where you are, honestly. This shapes everything.', fields: [
    { k: 'how_feel', t: 'long', l: 'How do you feel right now?', n: 'how you feel right now', h: 'The first thing that comes to mind.', req: true, max: 3000 },
    { k: 'how_want_to_feel', t: 'long', l: 'How do you want to feel, day in and day out?', max: 3000 },
    { k: 'mental_health_score', t: 'score', l: 'Mental wellbeing, past three months', min: 1, lo: 'Very low', hi: 'Strong' },
    { k: 'physical_health_score', t: 'score', l: 'Physical wellbeing, past three months', min: 1, lo: 'Very low', hi: 'Peak' },
    { k: 'spiritual_score', t: 'score', l: 'Spiritual grounding', min: 1, lo: 'None', hi: 'Deep' },
    { k: 'stress_score', t: 'score', l: 'Stress load right now', min: 1, lo: 'Light', hi: 'Crushing' },
    { k: 'energy_score', t: 'score', l: 'Daily energy', min: 1, lo: 'Empty', hi: 'Full' },
    { k: 'chapter_essentials', t: 'score', l: 'Essentials: getting to know myself', min: 1, lo: 'Not here', hi: 'Fully here' },
    { k: 'chapter_dark', t: 'score', l: 'Dark: I know the problem, and still feel stuck', min: 1, lo: 'Not here', hi: 'Fully here' },
    { k: 'chapter_light', t: 'score', l: 'Light: the next version of me is visible', min: 1, lo: 'Not here', hi: 'Fully here' },
    { k: 'moods', t: 'multi', l: 'Lately, I…', h: 'Select all that apply.', o: ['Feel low easily', 'Have mood swings', 'Feel fearful or anxious', 'Get angry quickly', 'Am grieving a loss', 'Feel numb or disconnected', 'Have low self-esteem', 'Hesitate to take action', 'Procrastinate', 'Feel cluttered or disorganised', 'Struggle to focus'] },
    { k: 'patterns', t: 'multi', l: 'Patterns I recognise in myself', o: ['Overthinking', 'All-or-nothing', 'Avoidance', 'Isolation', 'People-pleasing', 'Perfectionism', 'Comparison', 'Late-night scrolling', 'Emotional eating'] },
    { k: 'mh_diagnosis', t: 'choice', l: 'Have you ever been diagnosed with a mental health condition?', h: 'No details needed here.', o: ['No', 'Yes', 'Prefer to discuss privately'] },
    { k: 'stress_response', t: 'long', l: 'How do you typically respond to stress?', max: 2000 },
    { k: 'emotions_body', t: 'long', l: 'How do you feel emotions in your body? Any emotions you struggle to express?', max: 2000 },
    { k: 'relax', t: 'long', l: 'What helps you unwind or feel grounded?', max: 2000 },
    { k: 'bad_day', t: 'long', l: 'What does a bad day look like for you?', max: 2000 },
    { k: 'strengths', t: 'long', l: 'What has always worked for you?', max: 2000 },
  ] },
  { id: 'commitment', title: 'Commitment', intro: 'The programme provides the support. Your commitment drives the progress.', fields: [
    { k: 'will_reflect', t: 'choice', l: 'Are you willing to self-reflect, challenge yourself and step outside your comfort zone?', o: YN },
    { k: 'will_homework', t: 'choice', l: 'The programme includes daily check-ins and weekly tasks. Will you complete them?', o: YN },
    { k: 'discomfort_score', t: 'score', l: 'How ready are you to be uncomfortable?', min: 1, lo: 'Not yet', hi: 'Bring it' },
    { k: 'accountability_style', t: 'choice', l: 'How should we hold you accountable?', o: ['Direct: push me', 'Steady: firm and consistent', 'Gentle: encourage me'] },
    { k: 'investment_why', t: 'long', l: 'Why are you committed to investing your time and energy in this?', max: 2000 },
    { k: 'non_negotiables', t: 'long', l: 'Non-negotiables in your week', h: 'Work, family, faith, anything we must plan around.', max: 2000 },
  ] },
  { id: 'body', title: 'Body and movement', intro: 'Your baseline. Numbers are private and only used to set realistic goals.', fields: [
    { k: 'weight_kg', t: 'number', l: 'Current weight', n: 'your weight', unit: 'kg', min: 30, max: 300, step: 0.1, req: true },
    { k: 'height_cm', t: 'number', l: 'Height', n: 'your height', unit: 'cm', min: 120, max: 230, step: 1, req: true },
    { k: 'goal_weight_kg', t: 'number', l: 'Goal weight', unit: 'kg', h: 'Optional.', min: 30, max: 300, step: 0.1 },
    { k: 'waist_cm', t: 'number', l: 'Waist', unit: 'cm', h: 'Optional. Measured at the navel.', min: 40, max: 200, step: 0.5 },
    { k: 'weight_trend', t: 'choice', l: 'Over the last six months, your weight has been', o: ['Stable', 'Going up', 'Going down', 'Up and down'] },
    { k: 'body_connection', t: 'score', l: 'How connected do you feel to your body?', min: 1, lo: 'Disconnected', hi: 'Fully' },
    { k: 'body_image', t: 'long', l: 'How do you feel about your body and appearance?', max: 2000 },
    { k: 'body_tension', t: 'long', l: 'Any areas of tension or discomfort?', max: 1000 },
    { k: 'posture', t: 'long', l: 'Describe your typical posture and body language', max: 1000 },
    { k: 'exercise_freq', t: 'choice', l: 'How often do you exercise now?', o: ['Never', 'Occasionally', 'Several times a month', 'Several times a week', 'Daily'] },
    { k: 'training_history', t: 'choice', l: 'Your training history', o: ['Never trained', 'Trained in the past', 'On and off', 'Regular', 'Competitive or athlete'] },
    { k: 'movement_types', t: 'multi', l: 'Movement you do or would like to do', o: ['Strength', 'Walking', 'Running', 'Swimming', 'Padel or tennis', 'Football', 'Martial arts', 'Mobility or yoga', 'Cycling', 'Hiking', 'Other'] },
    { k: 'movement_enjoy', t: 'long', l: 'What physical activity do you actually enjoy?', max: 1000 },
    { k: 'movement_restricted', t: 'long', l: 'Movements you find difficult or restricted', max: 1000 },
    { k: 'injuries', t: 'long', l: 'Injuries, accidents or surgeries, in your own words', h: 'Approximate dates. No reports needed.', max: 1500 },
    { k: 'pain_now', t: 'choice', l: 'Are you in pain at the moment?', o: YN },
    { k: 'pain_where', t: 'text', l: 'If yes, where and what kind?', max: 300 },
    { k: 'vitality', t: 'choice', l: 'Drive and vitality', o: ['Low', 'Medium', 'High'] },
    { k: 'temperature', t: 'choice', l: 'You prefer', o: ['Hot weather', 'Cool weather', 'No preference'] },
    { k: 'sweat', t: 'choice', l: 'You sweat', o: ['Rarely', 'Normally', 'Heavily'] },
  ] },
  { id: 'food', title: 'Food and appetite', intro: 'No judgement. The plan is built around what you actually eat.', fields: [
    { k: 'fav_foods', t: 'long', l: 'Favourite foods', n: 'your favourite foods', req: true, max: 1500 },
    { k: 'least_fav_foods', t: 'long', l: 'Least favourite foods', h: 'Things we should never put on your plan.', max: 1500 },
    { k: 'comfort_foods', t: 'long', l: 'Comfort foods', h: 'What you reach for when stressed, tired or low, and when it usually happens.', max: 1500 },
    { k: 'cravings', t: 'long', l: 'Cravings and taste preferences', h: 'Sweet, salty, spicy, crunchy…', max: 1000 },
    { k: 'allergies', t: 'text', l: 'Allergies or intolerances', max: 300 },
    { k: 'eating_pattern', t: 'long', l: 'A typical day of eating, start to finish', max: 2000 },
    { k: 'breakfast_time', t: 'time', l: 'Breakfast' }, { k: 'lunch_time', t: 'time', l: 'Lunch' }, { k: 'dinner_time', t: 'time', l: 'Dinner' },
    { k: 'snacking', t: 'long', l: 'Snacking habits', max: 1000 },
    { k: 'hungry', t: 'choice', l: 'Do you usually feel hungry?', o: ['Often', 'Sometimes', 'Rarely'] },
    { k: 'regular_meals', t: 'choice', l: 'Do you eat regular meals regardless of appetite?', o: YN },
    { k: 'skip_meals', t: 'choice', l: 'Can you skip meals easily?', o: ['Easily', 'With difficulty', 'Never'] },
    { k: 'skip_reaction', t: 'text', l: 'How do you react when a meal is skipped or delayed?', max: 300 },
    { k: 'eating_out', t: 'choice', l: 'Eating out or delivery', o: ['Rarely', '1–2 times a week', '3–5 times a week', 'Most days'] },
    { k: 'who_cooks', t: 'text', l: 'Who cooks at home?', max: 150 },
    { k: 'water_litres', t: 'number', l: 'Water per day', unit: 'litres', min: 0, max: 8, step: 0.25 },
    { k: 'caffeine', t: 'choice', l: 'Tea, coffee or chai per day', o: ['None', '1', '2–3', '4+'] },
    { k: 'smoking', t: 'choice', l: 'Smoking or vaping', o: ['None', 'Occasionally', 'Daily'] },
    { k: 'digestion', t: 'multi', l: 'Digestion', h: 'Select any that apply.', o: ['No complaints', 'Acidity', 'Bloating', 'Gas', 'Heavy after eating', 'Sleepy after eating', 'Nausea'] },
    { k: 'food_notes', t: 'long', l: 'Anything else about food we should know?', max: 2000 },
  ] },
  { id: 'sleep', title: 'Sleep and recovery', intro: 'Recovery is where the work lands.', fields: [
    { k: 'wake_time', t: 'time', l: 'Usual wake time', n: 'your wake time', req: true },
    { k: 'bed_time', t: 'time', l: 'Usual sleep time', n: 'your sleep time', req: true },
    { k: 'sleep_hours', t: 'number', l: 'Hours of sleep, on average', unit: 'hours', min: 3, max: 12, step: 0.5 },
    { k: 'sleep_quality', t: 'score', l: 'Sleep quality', min: 1, lo: 'Broken', hi: 'Deep' },
    { k: 'sleep_issues', t: 'multi', l: 'Do you experience', o: ['Trouble falling asleep', 'Waking at night', 'Vivid dreams or nightmares', 'Waking unrefreshed', 'Feeling hot at night'] },
    { k: 'sleep_since', t: 'text', l: 'If sleep is a problem, since when?', max: 200 },
    { k: 'recovery', t: 'long', l: 'What helps you recover?', max: 1000 },
  ] },
  { id: 'week', title: 'Your week', intro: 'So check-ins and sessions fit your real life.', fields: [
    { k: 'work_pattern', t: 'long', l: 'Your work pattern', h: 'Hours, travel, busiest days.', max: 1000 },
    { k: 'unavailable_days', t: 'multi', l: 'Days you are usually unavailable', o: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
    { k: 'morning_checkin', t: 'time', l: 'Best time for a morning check-in' },
    { k: 'evening_checkin', t: 'time', l: 'Best time for an evening check-in' },
    { k: 'prayer_anchor', t: 'bool', l: 'Anchor my routines around prayer times' },
    { k: 'preferred_contact', t: 'multi', l: 'Preferred contact', o: ['WhatsApp', 'Telegram', 'Email', 'Phone'] },
    { k: 'hobbies', t: 'long', l: 'Hobbies and recreation', max: 1000 },
    { k: 'travel_upcoming', t: 'long', l: 'Travel or big events in the next 100 days', max: 1000 },
  ] },
  { id: 'care', title: 'Professional care', intro: 'We never need reports, results or medication lists. Your doctor handles those; we only need to know what to plan around.', fields: [
    { k: 'under_care', t: 'choice', l: 'Are you currently under the care of a doctor, therapist or other professional?', o: YN },
    { k: 'under_care_note', t: 'text', l: 'If yes, what kind of professional?', max: 200 },
    { k: 'has_physician', t: 'choice', l: 'Do you have a doctor you can see for a check-in before you start?', o: YN },
    { k: 'doctor_clearance_needed', t: 'choice', l: 'Is there anything a doctor should clear before you train?', o: ['No', 'Yes', 'Not sure'], n: 'whether a doctor should clear anything', req: true },
    { k: 'medication_affects', t: 'choice', l: 'Are you taking anything that may affect training, sleep or appetite?', o: ['No', 'Yes', 'Prefer to discuss privately'] },
    { k: 'bodywork_before', t: 'text', l: 'Bodywork you have tried', h: 'Massage, cupping, acupuncture…', max: 300 },
    { k: 'extra_notes', t: 'long', l: 'Anything else you want us to know', max: 5000 },
  ] },
]
const FIELDS = INTAKE.flatMap(s => s.fields)
const LIMIT: Record<string, number> = { text: 300, long: 3000, email: 254 }
function cleanIntake(raw: unknown) {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const f of FIELDS) {
    const v = src[f.k]
    if (v === undefined || v === null || v === '') continue
    switch (f.t) {
      case 'text': case 'long': case 'email': { const s = str(v, f.max || LIMIT[f.t]); if (s) out[f.k] = s; break }
      case 'date': if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[f.k] = v; break
      case 'time': if (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) out[f.k] = v; break
      case 'number': { const n = Number(v), st = f.step || 1; if (Number.isFinite(n) && n >= f.min! && n <= f.max! && Math.abs(n / st - Math.round(n / st)) < 1e-6) out[f.k] = n; break }
      case 'score': { const n = Number(v); if (Number.isInteger(n) && n >= (f.min ?? 1) && n <= 10) out[f.k] = n; break }
      case 'choice': if (typeof v === 'string' && f.o!.includes(v)) out[f.k] = v; break
      case 'multi': if (Array.isArray(v)) out[f.k] = f.o!.filter(o => v.includes(o)); break
      case 'bool': if (typeof v === 'boolean') out[f.k] = v; break
    }
  }
  return out
}
function intakeProblems(i: Record<string, any>) {
  const missing = FIELDS.filter(f => f.req && (i[f.k] === undefined || i[f.k] === '')).map(f => f.n || f.l.toLowerCase())
  if (i.full_name && !/\s/.test(i.full_name)) missing.push('your family name')
  if (i.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) missing.push('a valid email')
  if (i.dob) { const age = (Date.now() - Date.parse(i.dob + 'T00:00:00Z')) / (365.25 * 86400e3); if (!(age >= 18 && age < 100)) missing.push('a date of birth showing you are 18 or over') }
  return missing
}

// ---------- client view ----------
function progress(en: Record<string, any>, p: Record<string, any>) {
  if (!en.start_date) return null
  const today = riyadhDay()
  const raw = dayDiff(en.start_date, today) + 1 - (en.pause_days_total || 0)
  const started = raw >= 1
  const day = Math.max(0, Math.min(p.duration_days, raw))
  const third = p.duration_days / 3
  return {
    start_date: en.start_date, end_date: en.end_date, started, day, of: p.duration_days,
    days_to_start: started ? 0 : 1 - raw,
    phase: !started ? 0 : day <= third ? 1 : day <= 2 * third ? 2 : 3,
    percent: Math.round((day / p.duration_days) * 100),
  }
}
async function clientView(en: Record<string, any>, p: Record<string, any>, s: Record<string, any>) {
  const docs = await documents(p, s, { minor: en.price_minor, currency: en.currency })
  const bank = bankReady(s) ? { account_name: s.bank_account_name, bank_name: s.bank_name, iban: s.bank_iban, swift: s.bank_swift } : null
  const seller = s.provider_legal_name || 'Maktoub'
  const billedTo = en.invoice_billed_to || en.intake?.full_name || en.signature_name || en.invited_name
  const invoices = []
  if (en.invoice_number && en.payment_verified_at) invoices.push({ number: en.invoice_number, issued_at: en.invoice_issued_at, paid_on: en.payment_received_on, seller, seller_registration: s.provider_registration, billed_to: billedTo, description: `Maktoub | ${p.name} (${p.duration_days} days)`, label: money(en.price_minor, en.currency), method: 'Bank transfer' })
  if (en.voice_addon_invoice_number && en.voice_addon_verified_at) invoices.push({ number: en.voice_addon_invoice_number, issued_at: en.voice_addon_verified_at, paid_on: riyadhDay(new Date(en.voice_addon_verified_at)), seller, seller_registration: s.provider_registration, billed_to: billedTo, description: 'Voice analysis report (add-on)', label: money(en.voice_addon_minor || p.voice_addon_minor, en.currency), method: 'Bank transfer' })
  let report = null
  const { data: rep } = await db.from('maktoub_voice_reports').select('data,status,published_at').eq('enrolment_id', en.id).maybeSingle()
  if (rep?.status === 'published') report = { ...rep.data, published_at: rep.published_at }
  return {
    reference: en.reference_code, is_test: en.is_test, addressed_as: en.addressed_as,
    first_name: String(en.intake?.preferred_name || en.invited_name).trim().split(/\s+/)[0],
    programme: { name: p.name, category: p.category, duration_days: p.duration_days, prep_days: p.prep_days, live_sessions: p.live_sessions,
      price: money(en.price_minor, en.currency), voice_fee: p.voice_addon_minor ? money(p.voice_addon_minor, p.currency) : null },
    documents: docs,
    stage: en.stage, stage_label: STAGE_LABELS[en.stage],
    signed: en.signed_at ? { at: en.signed_at, name: en.signature_name } : null,
    payment: { reported_at: en.payment_reported_at, verified_at: en.payment_verified_at, bank },
    voice: {
      status: en.voice_addon_status, fee: p.voice_addon_minor ? money(p.voice_addon_minor, p.currency) : null,
      reported_at: en.voice_addon_reported_at, verified_at: en.voice_addon_verified_at,
      recording: en.voice_submitted_at ? { at: en.voice_submitted_at, duration_seconds: en.voice_duration_seconds } : null,
      locked: !!rep, report_ready: !!report,
    },
    intake_schema: INTAKE, intake: en.intake || {}, intake_saved_at: en.intake_saved_at, intake_submitted_at: en.intake_submitted_at,
    prep_due_at: en.prep_due_at, planning_meeting_at: en.planning_meeting_at, planning_meeting_completed_at: en.planning_meeting_completed_at,
    medical_status: en.medical_status,
    progress: progress(en, p), paused: en.stage === 'paused',
    invoices, report,
  }
}

async function loadInvite(token: unknown) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new HttpError(401, 'This private link is not valid.')
  const { data: en, error } = await db.from('maktoub_enrolments').select('*').eq('invite_token_hash', await sha256(token)).maybeSingle()
  if (error) throw error
  if (!en || en.revoked_at) throw new HttpError(401, 'This private link is no longer valid. Please contact Maktoub for a new one.')
  if (Date.parse(en.invite_expires_at) <= Date.now() && !en.signed_at) throw new HttpError(401, 'This proposal has expired. Please contact Maktoub for a new link.')
  return en
}

async function recordConsents(en: Record<string, any>, docs: any[], name: string, req: Request, ip: string) {
  const ipHash = await sha256('ip:' + ip)
  const ua = (req.headers.get('user-agent') || '').slice(0, 400)
  const { error } = await db.from('maktoub_enrolment_consents').insert(docs.map(d => ({
    enrolment_id: en.id, person_id: en.person_id, kind: d.kind, document_version: d.version, document_sha256: d.sha256,
    document_snapshot: d.title + '\n\n' + d.body, granted: true, signature_name: name, ip_hash: ipHash, user_agent: ua,
  })))
  if (error) throw error
}

async function clientAction(req: Request, origin: string, ip: string) {
  if (await limited('prg-ip:' + ip, 300, 3600)) throw new HttpError(429, 'Too many requests. Please wait a few minutes.')
  const isForm = (req.headers.get('content-type') || '').startsWith('multipart/form-data')
  const form = isForm ? await req.formData().catch(() => null) : null
  const body = isForm ? null : await req.json().catch(() => null)
  const token = isForm ? form?.get('token') : body?.token
  const action = isForm ? 'voice' : String(body?.action || '')
  if (typeof token === 'string' && !TOKEN_RE.test(token) && await limited('prg-bad:' + ip, 20, 3600)) throw new HttpError(429, 'Too many attempts.')
  const en = await loadInvite(token)
  const [p, s] = await Promise.all([programme(en.programme_code), bankSettings()])
  const now = new Date().toISOString()
  const update = async (changes: Record<string, unknown>) => {
    const { data, error } = await db.from('maktoub_enrolments').update(changes).eq('id', en.id).select('*').single()
    if (error) throw error
    return data
  }
  const view = async (row: Record<string, any>) => json(await clientView(row, p, s), 200, origin)

  if (action === 'load') {
    const fresh = await update({ last_seen_at: now, ...(en.first_opened_at ? {} : { first_opened_at: now }) })
    if (!en.first_opened_at) logEvent(en.id, 'client', 'opened')
    return view(fresh)
  }

  if (action === 'sign') {
    if (en.signed_at) return view(en)
    const name = str(body.signature_name, 150)
    if (!name || name.replace(/[^\p{L}]/gu, '').length < 3 || !/\s/.test(name)) throw new HttpError(400, 'Please type your full name, including your family name, as your signature.')
    const accepted = body.accept && typeof body.accept === 'object' ? body.accept as Record<string, boolean> : {}
    if (REQUIRED_DOCS.some(k => accepted[k] !== true)) throw new HttpError(400, 'Please confirm each document to continue.')
    const docs = await documents(p, s, { minor: en.price_minor, currency: en.currency })
    const sent = body.documents && typeof body.documents === 'object' ? body.documents as Record<string, string> : {}
    const wantVoice = body.voice_addon === true && !!p.voice_addon_minor
    const signing = docs.filter(d => REQUIRED_DOCS.includes(d.kind) || (wantVoice && d.kind === 'programme_voice'))
    if (signing.some(d => sent[d.kind] !== d.sha256)) throw new HttpError(409, 'A document was updated while you were reading. Please review it again.')
    await recordConsents(en, signing, name, req, ip)
    const fresh = await update({
      signed_at: now, signature_name: name, stage: en.stage === 'invited' ? 'signed' : en.stage,
      ...(wantVoice ? { voice_addon_status: 'requested', voice_addon_requested_at: now, voice_addon_minor: p.voice_addon_minor } : {}),
    })
    logEvent(en.id, 'client', 'signed', { versions: signing.map(d => d.version), voice_addon: wantVoice })
    alertFounder(fresh, 'Agreement signed ✍️', wantVoice ? 'Voice analysis add-on requested' : '')
    return view(fresh)
  }

  if (action === 'request_voice') {
    if (!en.signed_at) throw new HttpError(409, 'Please sign the agreement first.')
    if (!p.voice_addon_minor) throw new HttpError(409, 'Voice analysis is not available for this programme.')
    if (['requested', 'payment_reported', 'paid'].includes(en.voice_addon_status)) return view(en)
    const name = str(body.signature_name, 150)
    if (!name || !/\s/.test(name)) throw new HttpError(400, 'Please type your full name to confirm.')
    const docs = await documents(p, s, { minor: en.price_minor, currency: en.currency })
    const voiceDoc = docs.find(d => d.kind === 'programme_voice')!
    if (body.consent !== true || body.document_sha256 !== voiceDoc.sha256) throw new HttpError(409, 'Please review the voice analysis consent again.')
    await recordConsents(en, [voiceDoc], name, req, ip)
    const fresh = await update({ voice_addon_status: 'requested', voice_addon_requested_at: now, voice_addon_minor: p.voice_addon_minor })
    logEvent(en.id, 'client', 'voice_addon_requested')
    alertFounder(fresh, 'Voice analysis add-on requested 🎙')
    return view(fresh)
  }

  if (action === 'report_payment') {
    if (!en.signed_at) throw new HttpError(409, 'Please sign the agreement first.')
    if (!bankReady(s)) throw new HttpError(409, 'Bank details are being confirmed. Please wait for our message before transferring.')
    const note = [str(body.transfer_date, 20) && 'Date: ' + str(body.transfer_date, 20), str(body.sender_name, 150) && 'Sender: ' + str(body.sender_name, 150)].filter(Boolean).join(' · ') || null
    if (body.kind === 'voice') {
      if (en.voice_addon_status !== 'requested') return view(en)
      const fresh = await update({ voice_addon_status: 'payment_reported', voice_addon_reported_at: now })
      logEvent(en.id, 'client', 'voice_payment_reported', { note })
      alertFounder(fresh, 'Voice add-on transfer reported 💳 check your bank', note || '')
      return view(fresh)
    }
    if (en.payment_reported_at) return view(en)
    const fresh = await update({ payment_reported_at: now, payment_client_note: note, stage: en.stage === 'signed' ? 'payment_reported' : en.stage })
    logEvent(en.id, 'client', 'payment_reported', { note })
    alertFounder(fresh, 'Programme transfer reported 💳 check your bank', note || '')
    return view(fresh)
  }

  if (action === 'save_intake') {
    if (!en.signed_at) throw new HttpError(409, 'Please sign the agreement first.')
    if (en.intake_submitted_at) throw new HttpError(409, 'Your intake has already been submitted. Message us if something has changed.')
    const intake = cleanIntake(body.intake)
    if (body.submit === true) {
      const missing = intakeProblems(intake)
      if (missing.length) throw new HttpError(400, 'Please add ' + missing.join(', ') + '.')
      const fresh = await update({ intake, intake_saved_at: now, intake_submitted_at: now, ...(intake.timezone && intake.timezone !== 'Other' ? { timezone: intake.timezone } : {}) })
      logEvent(en.id, 'client', 'intake_submitted')
      alertFounder(fresh, 'Advanced intake submitted 📋')
      return view(fresh)
    }
    await update({ intake, intake_saved_at: now })
    return json({ saved_at: now }, 200, origin)
  }

  if (action === 'voice') {
    if (!['requested', 'payment_reported', 'paid'].includes(en.voice_addon_status)) throw new HttpError(409, 'Add voice analysis first.')
    const { data: rep } = await db.from('maktoub_voice_reports').select('enrolment_id').eq('enrolment_id', en.id).maybeSingle()
    if (rep) throw new HttpError(409, 'Your recording is already being analysed.')
    if (await limited('prg-voice:' + en.id, 12, 86400)) throw new HttpError(429, 'Too many uploads today. Please try again tomorrow.')
    const audio = form?.get('audio')
    if (!(audio instanceof File) || audio.size < 1000 || audio.size > MAX_AUDIO) throw new HttpError(400, 'The recording could not be read. Please record again.')
    const mime = (audio.type || '').split(';')[0].trim().toLowerCase()
    const ext = AUDIO_TYPES[mime]
    if (!ext) throw new HttpError(400, 'This recording format is not supported. Please try another browser.')
    const duration = Math.round(Number(form?.get('duration_seconds')))
    if (!Number.isFinite(duration) || duration < 120 || duration > 600) throw new HttpError(400, 'Please speak for at least two minutes (up to ten).')
    const path = `${en.id}/voice-${crypto.randomUUID()}.${ext}`
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, audio, { contentType: mime, upsert: false })
    if (upErr) { console.error('voice upload failed', upErr.message); throw new HttpError(500, 'The upload did not finish. Please try again.') }
    const previous = en.voice_storage_path
    let fresh
    try { fresh = await update({ voice_storage_path: path, voice_mime: mime, voice_duration_seconds: duration, voice_submitted_at: en.voice_submitted_at || now }) }
    catch (e) { await db.storage.from(BUCKET).remove([path]); throw e }
    if (previous && previous !== path) await db.storage.from(BUCKET).remove([previous])
    logEvent(en.id, 'client', previous ? 'voice_replaced' : 'voice_submitted', { duration_seconds: duration, bytes: audio.size })
    if (!previous) alertFounder(fresh, 'Voice recording submitted 🎧', `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`)
    return view(fresh)
  }

  throw new HttpError(400, 'Invalid request.')
}

// ---------- invitations (founder console and Telegram) ----------
async function createInvite(opts: { name: string; phone: string; country?: string; test: boolean; voiceOffer: boolean; addressedAs?: string; uid: string | null; via: 'founder' | 'telegram' }) {
  const p = await programme('readiness-90')
  const s = await bankSettings()
  if (!opts.test && !readyForReal(p, s)) throw new HttpError(409, 'Before inviting a real client: approve the Readiness documents in the console (bank details and legal name are already used from onboarding settings).')
  const name = str(opts.name, 150)
  const parsed = parsePhoneNumberFromString(String(opts.phone || ''), ((opts.country || 'SA').toUpperCase()) as any)
  const fictional = opts.test && /^\+447700900\d{3}$/.test(parsed?.number || '')
  if (!name || !(parsed?.isValid() || fictional)) throw new HttpError(400, 'A name and a valid phone number are required.')
  const phone = parsed!.number as string
  if (opts.test && !fictional) throw new HttpError(400, 'Test invitations must use a fictional number +44 7700 900xxx.')
  const { data: existing } = await db.from('maktoub_people').select('id,full_name').eq('normalized_phone', phone).maybeSingle()
  const { data: up, error } = await db.rpc('upsert_maktoub_person', {
    p_full_name: existing?.full_name || name, p_normalized_phone: phone, p_email: null,
    p_source: opts.test ? 'synthetic_test' : 'founder_manual', p_source_detail: 'readiness_invite',
    p_interest_matchmaking: false, p_consent_status: 'unknown',
  })
  if (error || !up?.[0]?.person_id) throw error || new Error('person failed')
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = 'RP-' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => alphabet[b % alphabet.length]).join('')
    const { data, error: insErr } = await db.from('maktoub_enrolments').insert({
      person_id: up[0].person_id, programme_code: p.code, reference_code: ref, invite_token_hash: await sha256(token),
      invite_expires_at: new Date(Date.now() + p.invite_valid_days * 86400e3).toISOString(), is_test: opts.test,
      invited_name: name, invited_phone: phone, addressed_as: opts.addressedAs === 'woman' ? 'woman' : 'man',
      price_minor: p.price_minor, currency: p.currency, created_by: opts.uid,
      voice_addon_status: opts.voiceOffer ? 'offered' : 'none',
    }).select('id,reference_code,invite_expires_at').single()
    if (!insErr) {
      logEvent(data.id, opts.via, 'invited', { test: opts.test })
      return { id: data.id, reference: data.reference_code, expires_at: data.invite_expires_at, url: `${SITE}/ready/?invite=${token}` }
    }
    if (insErr.code === '23505' && String(insErr.message).includes('one_open')) throw new HttpError(409, 'This person already has an open Readiness enrolment. Reissue its link from the console.')
    if (insErr.code !== '23505') throw insErr
  }
  throw new Error('could not allocate reference')
}

// ---------- founder console ----------
const LIST_COLS = 'id,reference_code,invited_name,invited_phone,is_test,revoked_at,invite_expires_at,created_at,first_opened_at,last_seen_at,stage,signed_at,payment_reported_at,payment_verified_at,voice_addon_status,voice_submitted_at,intake_submitted_at,prep_due_at,planning_meeting_at,planning_meeting_completed_at,medical_status,start_date,end_date,pause_days_total,intake->>full_name'

async function founderAction(req: Request, origin: string, jwt: string) {
  const { data: identity, error: authErr } = await db.auth.getUser(jwt)
  if (authErr || !identity.user) throw new HttpError(401, 'Please sign in again.')
  const { data: admin } = await db.from('maktoub_admins').select('role').eq('user_id', identity.user.id).maybeSingle()
  if (admin?.role !== 'founder') throw new HttpError(403, 'Founder access required.')
  if (await limited('prg-admin:' + identity.user.id, 600, 3600)) throw new HttpError(429, 'Too many requests.')
  const uid = identity.user.id
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid request.')
  const action = String(body.action || '')
  const now = new Date().toISOString()
  const p = await programme('readiness-90')
  const s = await bankSettings()
  const getOne = async (id: unknown) => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Record required.')
    const { data, error } = await db.from('maktoub_enrolments').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    if (!data) throw new HttpError(404, 'Record not found.')
    return data
  }
  const save = async (id: string, changes: Record<string, unknown>) => {
    const { data, error } = await db.from('maktoub_enrolments').update(changes).eq('id', id).select('*').single()
    if (error) throw new HttpError(400, error.message.includes('enrolment_paid_before_active') ? 'Verify payment and set a start date first.' : error.message)
    return data
  }

  if (action === 'admin_overview') {
    const { data, error } = await db.from('maktoub_enrolments').select(LIST_COLS).order('created_at', { ascending: false }).limit(300)
    if (error) throw error
    return json({
      programme: { code: p.code, name: p.name, price: money(p.price_minor, p.currency), voice_fee: p.voice_addon_minor ? money(p.voice_addon_minor, p.currency) : null, documents_approved_at: p.documents_approved_at, duration_days: p.duration_days, prep_days: p.prep_days },
      checks: { bank_ready: bankReady(s), legal_name: !!s.provider_legal_name, documents_approved: !!p.documents_approved_at, telegram_token: !!BOT, ready_for_real_invites: readyForReal(p, s) },
      documents: await documents(p, s, { minor: p.price_minor, currency: p.currency }),
      records: data, stage_labels: STAGE_LABELS, today: riyadhDay(),
    }, 200, origin)
  }

  if (action === 'admin_approve_documents') {
    if (body.confirm !== true) throw new HttpError(400, 'Confirmation required.')
    const { error } = await db.from('maktoub_programmes').update({ documents_approved_at: now, documents_approved_by: uid, updated_at: now }).eq('code', p.code)
    if (error) throw error
    return json({ success: true }, 200, origin)
  }

  if (action === 'admin_invite') {
    return json(await createInvite({ name: body.full_name, phone: body.phone, country: body.country_iso2, test: body.test === true, voiceOffer: body.voice_offer === true, addressedAs: body.addressed_as, uid, via: 'founder' }), 200, origin)
  }

  if (action === 'admin_get') {
    const en = await getOne(body.id)
    const [{ data: consents }, { data: events }, { data: report }] = await Promise.all([
      db.from('maktoub_enrolment_consents').select('kind,document_version,granted,signature_name,created_at,withdrawn_at').eq('enrolment_id', en.id).order('created_at'),
      db.from('maktoub_enrolment_events').select('actor,action,detail,created_at').eq('enrolment_id', en.id).order('created_at', { ascending: false }).limit(200),
      db.from('maktoub_voice_reports').select('data,status,published_at,updated_at').eq('enrolment_id', en.id).maybeSingle(),
    ])
    const { invite_token_hash: _h, ...record } = en
    return json({ record, consents, events, report, progress: progress(en, p), stage_labels: STAGE_LABELS, intake_schema: INTAKE }, 200, origin)
  }

  if (action === 'admin_update') {
    const en = await getOne(body.id)
    const op = String(body.op || '')
    let changes: Record<string, unknown> = {}
    switch (op) {
      case 'verify_payment': {
        if (en.payment_verified_at) throw new HttpError(409, 'Already verified.')
        if (!en.signed_at) throw new HttpError(409, 'The agreement has not been signed.')
        const received = str(body.received_on, 10)
        changes = { payment_verified_at: now, payment_verified_by: uid, payment_bank_reference: str(body.bank_reference, 120), invoice_billed_to: str(body.billed_to, 150) || en.invoice_billed_to,
          ...(received && /^\d{4}-\d{2}-\d{2}$/.test(received) ? { payment_received_on: received } : {}),
          stage: ['invited', 'signed', 'payment_reported'].includes(en.stage) ? 'meeting_pending' : en.stage }
        break
      }
      case 'verify_voice_payment':
        if (!['requested', 'payment_reported'].includes(en.voice_addon_status)) throw new HttpError(409, 'No voice add-on awaiting payment.')
        changes = { voice_addon_status: 'paid', voice_addon_verified_at: now }; break
      case 'offer_voice':
        if (en.voice_addon_status !== 'none' && en.voice_addon_status !== 'declined') throw new HttpError(409, 'Voice analysis is already offered or requested.')
        changes = { voice_addon_status: 'offered' }; break
      case 'set_stage': {
        const stage = String(body.stage || '')
        if (!PREP_STAGES.includes(stage)) throw new HttpError(400, 'Choose a preparation stage.')
        if (!en.payment_verified_at) throw new HttpError(409, 'Verify payment before moving into preparation.')
        changes = { stage }; break
      }
      case 'set_meeting': {
        const at = str(body.at, 40)
        if (!at || Number.isNaN(Date.parse(at))) throw new HttpError(400, 'Choose a date and time.')
        changes = { planning_meeting_at: new Date(at).toISOString() }; break
      }
      case 'meeting_done':
        changes = { planning_meeting_completed_at: now, stage: PREP_STAGES.indexOf(en.stage) < PREP_STAGES.indexOf('meeting_completed') ? 'meeting_completed' : en.stage }; break
      case 'set_medical': {
        const status = String(body.status || '')
        if (!['not_started', 'pending', 'cleared', 'cleared_with_constraints', 'not_required'].includes(status)) throw new HttpError(400, 'Choose a status.')
        changes = { medical_status: status, medical_constraints: status === 'cleared_with_constraints' ? str(body.constraints, 600) : null }; break
      }
      case 'set_start': {
        const d = str(body.date, 10)
        if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Choose a start date.')
        if (!en.payment_verified_at) throw new HttpError(409, 'Verify payment first.')
        changes = { start_date: d, stage: ['active', 'paused', 'completed'].includes(en.stage) ? en.stage : 'start_confirmed' }; break
      }
      case 'activate':
        if (!en.start_date || !en.payment_verified_at) throw new HttpError(409, 'Verify payment and confirm a start date first.')
        changes = { stage: 'active' }; break
      case 'pause':
        if (en.stage !== 'active') throw new HttpError(409, 'Only an active programme can be paused.')
        changes = { stage: 'paused', paused_at: now }; break
      case 'resume': {
        if (en.stage !== 'paused' || !en.paused_at) throw new HttpError(409, 'Not paused.')
        const days = Math.max(0, dayDiff(riyadhDay(new Date(en.paused_at)), riyadhDay()))
        changes = { stage: 'active', paused_at: null, pause_days_total: (en.pause_days_total || 0) + days }; break
      }
      case 'complete':
        if (!['active', 'paused'].includes(en.stage)) throw new HttpError(409, 'Only an active programme can be completed.')
        changes = { stage: 'completed', completed_at: now }; break
      case 'cancel': changes = { stage: 'cancelled' }; break
      case 'note': changes = { founder_note: str(body.text, 4000) }; break
      case 'billed_to': changes = { invoice_billed_to: str(body.text, 150) }; break
      case 'revoke': changes = { revoked_at: now }; break
      case 'reissue': {
        const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
        await save(en.id, { invite_token_hash: await sha256(token), revoked_at: null, invite_expires_at: new Date(Date.now() + p.invite_valid_days * 86400e3).toISOString() })
        logEvent(en.id, 'founder', 'reissued')
        return json({ url: `${SITE}/ready/?invite=${token}` }, 200, origin)
      }
      case 'voice_link': {
        if (!en.voice_storage_path) throw new HttpError(404, 'No recording.')
        const { data } = await db.storage.from(BUCKET).createSignedUrl(en.voice_storage_path, 600)
        logEvent(en.id, 'founder', 'voice_listened')
        return json({ url: data?.signedUrl }, 200, origin)
      }
      case 'delete_voice': {
        if (!en.voice_storage_path) throw new HttpError(404, 'No recording.')
        const { error } = await db.storage.from(BUCKET).remove([en.voice_storage_path])
        if (error) throw error
        changes = { voice_storage_path: null, voice_mime: null }
        logEvent(en.id, 'founder', 'voice_deleted', { submitted_at: en.voice_submitted_at })
        break
      }
      default: throw new HttpError(400, 'Unknown action.')
    }
    const fresh = await save(en.id, changes)
    logEvent(en.id, 'founder', op, op === 'note' ? {} : { stage: fresh.stage })
    return json({ success: true, stage: fresh.stage }, 200, origin)
  }

  if (action === 'admin_save_report') {
    const en = await getOne(body.id)
    if (!['requested', 'payment_reported', 'paid'].includes(en.voice_addon_status)) throw new HttpError(409, 'Voice analysis has not been requested.')
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null
    if (!data || JSON.stringify(data).length > 120000) throw new HttpError(400, 'Report data is missing or too large.')
    const publish = body.publish === true
    if (publish && en.voice_addon_status !== 'paid') throw new HttpError(409, 'Verify the voice add-on payment before publishing.')
    const row: Record<string, unknown> = { enrolment_id: en.id, data, updated_at: now, updated_by: uid }
    if (publish) Object.assign(row, { status: 'published', published_at: now, published_by: uid })
    else if (body.unpublish === true) Object.assign(row, { status: 'draft', published_at: null })
    const { error } = await db.from('maktoub_voice_reports').upsert(row, { onConflict: 'enrolment_id' })
    if (error) throw error
    logEvent(en.id, 'founder', publish ? 'report_published' : body.unpublish ? 'report_unpublished' : 'report_saved')
    return json({ success: true }, 200, origin)
  }

  if (action === 'admin_purge_test') {
    const en = await getOne(body.id)
    if (!en.is_test) throw new HttpError(403, 'Only synthetic test records can be purged.')
    const { data: files } = await db.storage.from(BUCKET).list(en.id)
    if (files?.length) await db.storage.from(BUCKET).remove(files.map(f => `${en.id}/${f.name}`))
    for (const t of ['maktoub_voice_reports', 'maktoub_enrolment_consents', 'maktoub_enrolment_events']) {
      const { error } = await db.from(t).delete().eq('enrolment_id', en.id)
      if (error) throw error
    }
    const { error } = await db.from('maktoub_enrolments').delete().eq('id', en.id)
    if (error) throw error
    const { data: others } = await db.from('maktoub_enrolments').select('id').eq('person_id', en.person_id).limit(1)
    const { data: onb } = await db.from('maktoub_onboarding').select('id').eq('person_id', en.person_id).limit(1)
    const { data: person } = await db.from('maktoub_people').select('source').eq('id', en.person_id).maybeSingle()
    if (!others?.length && !onb?.length && person?.source === 'synthetic_test') await db.from('maktoub_people').delete().eq('id', en.person_id)
    return json({ success: true }, 200, origin)
  }

  // Telegram commands: show the bot's current webhook, or connect this function as its webhook.
  if (action === 'admin_telegram') {
    if (!BOT) throw new HttpError(409, 'No Telegram bot token is configured as an edge-function secret.')
    const info = await telegram('getWebhookInfo', {})
    if (body.connect === true) {
      if (info.url && !String(info.url).includes('/maktoub-programme') && body.replace !== true) {
        throw new HttpError(409, 'This bot already sends its updates elsewhere. Connecting would replace that. Confirm to replace.')
      }
      let { data: cfg } = await db.from('maktoub_internal_config').select('value').eq('key', 'telegram_webhook_secret').maybeSingle()
      if (!cfg?.value) {
        const value = hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
        const { error } = await db.from('maktoub_internal_config').insert({ key: 'telegram_webhook_secret', value })
        if (error) throw error
        cfg = { value }
      }
      await telegram('setWebhook', { url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/maktoub-programme`, secret_token: cfg.value, allowed_updates: ['message'], drop_pending_updates: false })
      await telegram('setMyCommands', { commands: [{ command: 'ready', description: 'Send a Readiness Programme proposal' }, { command: 'readytest', description: 'Create a test proposal' }, { command: 'readiness', description: 'Readiness clients needing action' }], scope: { type: 'chat', chat_id: Number(FOUNDER_CHAT) } })
      return json({ connected: true, previous_url: info.url ? String(info.url).replace(/bot[^/]+/, 'bot…') : null }, 200, origin)
    }
    return json({ url: info.url ? String(info.url).replace(/\?.*$/, '') : null, connected_here: String(info.url || '').includes('/maktoub-programme'), pending_update_count: info.pending_update_count, last_error_message: info.last_error_message || null }, 200, origin)
  }

  throw new HttpError(400, 'Invalid request.')
}

// ---------- Telegram webhook (founder only) ----------
async function telegramAction(req: Request) {
  const { data: cfg } = await db.from('maktoub_internal_config').select('value').eq('key', 'telegram_webhook_secret').maybeSingle()
  if (!cfg?.value || req.headers.get('x-telegram-bot-api-secret-token') !== cfg.value) return new Response('forbidden', { status: 403 })
  const update = await req.json().catch(() => null)
  const msg = update?.message
  // Always 200 to Telegram so it does not retry; ignore anything not from the founder's private chat.
  if (!msg?.text || String(msg.chat?.id) !== FOUNDER_CHAT || msg.chat?.type !== 'private') return new Response('ok')
  const reply = (text: string, extra: Record<string, unknown> = {}) =>
    telegram('sendMessage', { chat_id: FOUNDER_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch(e => console.error('reply failed', e.message))
  const text = String(msg.text).trim()
  const [cmdRaw, ...rest] = text.split(/\s+/)
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '')
  try {
    if (cmd === '/ready' || cmd === '/readytest') {
      const test = cmd === '/readytest'
      const voice = rest.some(w => /^(\+?voice)$/i.test(w))
      const words = rest.filter(w => !/^(\+?voice)$/i.test(w))
      const phoneStart = words.findIndex(w => /^\+?\d/.test(w))
      const name = (phoneStart === -1 ? words : words.slice(0, phoneStart)).join(' ')
      const phone = test ? '+447700900' + String(Math.floor(Math.random() * 1000)).padStart(3, '0') : (phoneStart === -1 ? '' : words.slice(phoneStart).join(''))
      if (!name || !phone) {
        await reply('Usage:\n<code>/ready Anas +9665XXXXXXXX</code>\n<code>/ready Anas +9665XXXXXXXX voice</code> to offer voice analysis\n<code>/readytest Anas</code> for a synthetic test')
        return new Response('ok')
      }
      const inv = await createInvite({ name, phone, test, voiceOffer: voice, uid: null, via: 'telegram' })
      await reply(`<b>${test ? 'Test proposal' : 'Readiness proposal'} ready</b> · ${esc(inv.reference)}\n${esc(name)}${voice ? ' · voice analysis offered' : ''}\nValid until ${esc(new Date(inv.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Riyadh' }))}\n\nForward this private link to him (it is shown only once):`)
      await reply(inv.url, { reply_markup: { inline_keyboard: [[{ text: 'Open record', url: `${SITE}/ready/admin/#${inv.id}` }]] } })
      return new Response('ok')
    }
    if (cmd === '/readiness') {
      const { data } = await db.from('maktoub_enrolments').select('id,reference_code,invited_name,stage,payment_reported_at,payment_verified_at,voice_addon_status,prep_due_at,start_date,is_test').is('revoked_at', null).not('stage', 'in', '(completed,cancelled)').order('created_at', { ascending: false }).limit(20)
      const rows = (data || []).filter(r => !r.is_test)
      if (!rows.length) { await reply('No open Readiness enrolments.'); return new Response('ok') }
      const lines = rows.map(r => {
        const flag = (r.payment_reported_at && !r.payment_verified_at) || r.voice_addon_status === 'payment_reported' ? ' · 💳 verify' : ''
        const due = r.prep_due_at && !r.start_date ? ` · prep due ${new Date(r.prep_due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' })}` : ''
        return `• <b>${esc(r.invited_name)}</b> ${esc(r.reference_code)} · ${esc(STAGE_LABELS[r.stage])}${flag}${due}`
      })
      await reply(lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: 'Open console', url: `${SITE}/ready/admin/` }]] } })
      return new Response('ok')
    }
  } catch (e) {
    await reply('⚠️ ' + esc(e instanceof HttpError ? e.message : 'Something went wrong creating the proposal.'))
    if (!(e instanceof HttpError)) console.error('telegram command failed', (e as Error).message)
  }
  return new Response('ok')
}

Deno.serve(async (req) => {
  if (req.headers.has('x-telegram-bot-api-secret-token')) {
    try { return await telegramAction(req) } catch (e) { console.error('telegram error', (e as Error).message); return new Response('ok') }
  }
  const origin = req.headers.get('origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
  if (!origin || !ORIGINS.has(origin)) return json({ error: 'Forbidden' }, 403, origin)
  if (req.method !== 'POST') return json({ error: 'Method' }, 405, origin)
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
  try {
    const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    return jwt ? await founderAction(req, origin, jwt) : await clientAction(req, origin, ip)
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin)
    console.error('maktoub-programme error', (e as Error).message)
    return json({ error: 'Something went wrong on our side. Please try again.' }, 500, origin)
  }
})
