// Maktoub accountability bot ("companion").
// One private Telegram group per client: the client, the founder and this bot.
// Each morning (09:00 Riyadh, pg_cron → action "daily") the bot posts the next reflection
// of her process; her replies, in text or voice, are logged against her onboarding record
// so the founder sees accountability both in the group and in the console.
// If her onboarding voice answer is still outstanding, a voice note of 15s+ sent in the group
// is saved as that answer (covered by the voice consent she signed at step 1).
//
// Callers:
//   Telegram webhook  → header X-Telegram-Bot-Api-Secret-Token = internal_config('companion_webhook_secret')
//   Internal (cron, maktoub-onboard) → header x-notify-secret = internal_config('notify_secret'),
//     body { action: 'daily' | 'portal_message' | 'setup' | 'link_code' , ... }
// Deploy with verify_jwt = false (Telegram sends no JWT). Secret: MAKTOUB_COMPANION_BOT_TOKEN.
import { createClient } from 'npm:@supabase/supabase-js@2'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const BOT = Deno.env.get('MAKTOUB_COMPANION_BOT_TOKEN') || ''
// The founder's Telegram user id (same id the founder alert bot already writes to privately).
const FOUNDER = Number(Deno.env.get('MAKTOUB_FOUNDER_TELEGRAM_ID') || Deno.env.get('MAKTOUB_TELEGRAM_CHAT_ID') || '970663486')
const SELF_URL = 'https://pmjvpnqmklxxpswwvbmv.supabase.co/functions/v1/maktoub-companion'
const PORTAL = 'https://maktoub.app/onboard/'
const BUCKET = 'maktoub-onboarding'
const AUDIO: Record<string, string> = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/webm': 'webm' }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const riyadhDay = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' })
const config = async (key: string) => (await db.from('maktoub_internal_config').select('value').eq('key', key).maybeSingle()).data?.value as string | undefined

type Ob = Record<string, any>
const firstName = (ob: Ob) => String(ob.intake?.full_name || ob.signature_name || ob.invited_name || '').trim().split(/\s+/)[0]
const spouse = (ob: Ob) => ob.client_addressed_as === 'man' ? 'wife' : 'husband'
const voiceOutstanding = (ob: Ob) => !ob.voice_submitted_at
const awaitingReply = (ob: Ob) => !!ob.companion_last_prompt_at && (!ob.companion_last_reply_at || Date.parse(ob.companion_last_reply_at) < Date.parse(ob.companion_last_prompt_at))

// ---------- The process: 21 days, then a weekly rhythm ----------
// {spouse} is replaced per client. Each prompt is one small act of honesty, answered in a few lines or a voice note.
const PROCESS: { theme: string; ask: string }[] = [
  { theme: 'Intention', ask: 'In one or two sentences: why now? What made this the season you said yes to Maktoub?' },
  { theme: 'The picture', ask: 'Describe an ordinary Tuesday evening with your future {spouse}. Not the wedding, the Tuesday.' },
  { theme: 'Non‑negotiables', ask: 'Name three things you will not compromise on. Then one thing you thought was a must but are willing to soften.' },
  { theme: 'Your pattern', ask: 'Looking back, what pattern repeats in the people you were drawn to? Be kind to yourself, but be honest.' },
  { theme: 'Family', ask: 'How involved do you want your family to be, and what would make you feel supported rather than pressured?' },
  { theme: 'Body', ask: 'How did you sleep, move and eat this week? Readiness lives in the body too. One line is enough.' },
  { theme: 'Week one, closed', ask: 'What did you notice about yourself this week? What surprised you?' },
  { theme: 'Being chosen', ask: 'When do you feel most chosen by someone? Describe a moment, from any relationship.' },
  { theme: 'Conflict', ask: 'When you are hurt, what do you do first: go quiet, explain, or leave the room? What would you like to do instead?' },
  { theme: 'Faith & meaning', ask: 'What role should faith or meaning play in your marriage, day to day?' },
  { theme: 'Money', ask: 'How do you want money to feel between the two of you: shared, separate, planned, spontaneous?' },
  { theme: 'Letting go', ask: 'What is one belief about love you are ready to put down?' },
  { theme: 'Energy', ask: 'Who in your life leaves you feeling bigger after you see them? What do they do?' },
  { theme: 'Week two, closed', ask: 'One word for how you feel about marriage today, compared with two weeks ago.' },
  { theme: 'The first meeting', ask: 'Imagine your first Maktoub introduction. What would you like them to know about you in the first ten minutes?' },
  { theme: 'Red flags', ask: 'What would tell you, early, that someone is not right, even if everything looks right on paper?' },
  { theme: 'Green flags', ask: 'And what small thing would tell you someone is worth a second meeting?' },
  { theme: 'Your offering', ask: 'What do you bring to a marriage that you rarely say out loud?' },
  { theme: 'Space', ask: 'How much time alone do you need in a week to feel like yourself?' },
  { theme: 'Gratitude', ask: 'Name three things in your life right now you would want your future {spouse} to love too.' },
  { theme: 'Three weeks', ask: 'You have shown up for three weeks. What feels clearer now? What do you want Deena to know before introductions?' },
]
const WEEKLY: { theme: string; ask: string }[] = [
  { theme: 'Weekly check‑in', ask: 'How are you, honestly, this week? One line on your heart, one on your energy.' },
  { theme: 'Weekly check‑in', ask: 'Anything that shifted in what you are looking for? Anything that became firmer?' },
  { theme: 'Weekly check‑in', ask: 'What did you do for yourself this week that your future {spouse} would be glad to see?' },
]
function promptFor(day: number, ob: Ob) {
  const p = day <= PROCESS.length ? PROCESS[day - 1] : WEEKLY[Math.floor((day - PROCESS.length - 1) / 7) % WEEKLY.length]
  return { theme: p.theme, ask: p.ask.replaceAll('{spouse}', spouse(ob)) }
}
// After the 21 days, prompts are weekly (every 7th day after day 21).
const isPromptDay = (day: number) => day <= PROCESS.length || (day - PROCESS.length) % 7 === 0

const ACKS = ['Received, thank you. 🤍', 'Noted and held. Thank you for showing up today.', 'Thank you. That took honesty.', 'Received. Deena will see this too.', 'Beautiful. See you tomorrow morning.']

// ---------- Telegram ----------
async function tg(method: string, payload: Record<string, unknown>) {
  if (!BOT) throw new Error('MAKTOUB_COMPANION_BOT_TOKEN is not set')
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.ok) throw new Error(`telegram ${method} ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j.result
}
async function say(ob: Ob | null, chatId: number, text: string, opts: { kind?: string; day?: number; button?: [string, string] } = {}) {
  const res = await tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(opts.button ? { reply_markup: { inline_keyboard: [[{ text: opts.button[0], url: opts.button[1] }]] } } : {}),
  })
  if (ob) await log(ob, chatId, 'bot', opts.kind || 'message', text.replace(/<[^>]+>/g, ''), opts.day, res?.message_id)
  return res
}
const log = (ob: Ob, chat_id: number, from_role: string, kind: string, text: string | null, day?: number, tg_message_id?: number) =>
  db.from('maktoub_companion_log').insert({ onboarding_id: ob.id, chat_id, from_role, kind, text: text?.slice(0, 8000) ?? null, day: day ?? ob.companion_day ?? null, tg_message_id: tg_message_id ?? null })
    .then(({ error }) => { if (error) console.error('companion log failed', error) })
const event = (ob: Ob, action: string, detail: Record<string, unknown> = {}) =>
  db.from('maktoub_onboarding_events').insert({ onboarding_id: ob.id, actor: 'system', action, detail }).then(({ error }) => { if (error) console.error('event log failed', error) })
async function patch(ob: Ob, changes: Record<string, unknown>) {
  const { data, error } = await db.from('maktoub_onboarding').update(changes).eq('id', ob.id).select('*').single()
  if (error) throw error
  return data as Ob
}

// ---------- Daily prompt ----------
async function sendPrompt(ob: Ob, resend = false) {
  const chat = Number(ob.companion_chat_id)
  const unanswered = awaitingReply(ob)
  let day = ob.companion_day
  if (!resend) {
    day = ob.companion_day + 1
    // Skip silent days in the weekly rhythm, but still count them.
    while (!isPromptDay(day)) day++
    ob = await patch(ob, { companion_day: day, companion_last_prompt_at: new Date().toISOString(), ...(unanswered ? { companion_streak: 0 } : {}) })
  }
  const p = promptFor(day, ob)
  const lines = [
    `<b>Day ${day} · ${esc(p.theme)}</b>`,
    '',
    esc(p.ask),
    '',
    '<i>Reply here in words or a voice note, whenever today allows.</i>',
  ]
  if (!resend && unanswered) lines.unshift('<i>Yesterday’s reflection is still open. Answer it whenever you can.</i>', '')
  if (voiceOutstanding(ob) && (day === 1 || day % 3 === 0)) {
    lines.push('', `🎙 Your onboarding voice answer is still to come: describe your ideal weekend with your ${spouse(ob)}, about two minutes. Send it here as a voice note when it’s ready.`)
  }
  await say(ob, chat, lines.join('\n'), { kind: 'prompt', day })
}

async function daily() {
  const { data, error } = await db.from('maktoub_onboarding').select('*').not('companion_chat_id', 'is', null).is('companion_paused_at', null).is('revoked_at', null)
  if (error) throw error
  const today = riyadhDay(new Date())
  const out: unknown[] = []
  for (const ob of data ?? []) {
    if (ob.companion_last_prompt_at && riyadhDay(ob.companion_last_prompt_at) === today) { out.push({ id: ob.id, skipped: 'already today' }); continue }
    // Weekly rhythm: after day 21 only prompt on the 7th day.
    if (ob.companion_day >= PROCESS.length && ob.companion_last_prompt_at && Date.now() - Date.parse(ob.companion_last_prompt_at) < 6.5 * 86400000) { out.push({ id: ob.id, skipped: 'weekly' }); continue }
    try { await sendPrompt(ob); out.push({ id: ob.id, sent: true }) } catch (e) { console.error('daily prompt failed', ob.id, e); out.push({ id: ob.id, sent: false }) }
  }
  return out
}

// ---------- Voice note from the group becomes her onboarding voice answer ----------
async function saveVoice(ob: Ob, chat: number, file: { file_id: string; duration?: number; mime_type?: string; file_size?: number }) {
  const duration = Math.round(file.duration || 0)
  if (duration < 15) return say(ob, chat, 'That one is a little short to keep as your voice answer. Aim for about two minutes when you’re ready. 🤍')
  if (duration > 600) return say(ob, chat, 'That recording is longer than ten minutes. Could you send a shorter version, about two minutes?')
  if ((file.file_size || 0) > 20 * 1024 * 1024) return say(ob, chat, 'That file is too large for Telegram to pass to us. Please record it on your portal instead.', { button: ['Open my portal', PORTAL] })
  const mime = (file.mime_type || 'audio/ogg').split(';')[0].toLowerCase()
  const ext = AUDIO[mime]
  if (!ext) return say(ob, chat, 'I couldn’t read that audio format. A regular Telegram voice note works best.')
  const meta = await tg('getFile', { file_id: file.file_id })
  const r = await fetch(`https://api.telegram.org/file/bot${BOT}/${meta.file_path}`)
  if (!r.ok) throw new Error('voice download ' + r.status)
  const bytes = new Uint8Array(await r.arrayBuffer())
  const path = `${ob.id}/voice-${crypto.randomUUID()}.${ext}`
  const { error: upErr } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false })
  if (upErr) throw upErr
  try {
    await patch(ob, { voice_storage_path: path, voice_mime: mime, voice_duration_seconds: duration, voice_submitted_at: new Date().toISOString(), voice_source: 'telegram' })
  } catch (e) { await db.storage.from(BUCKET).remove([path]); throw e }
  event(ob, 'voice_submitted', { duration_seconds: duration, bytes: bytes.length, via: 'telegram' })
  const m = Math.floor(duration / 60), s = String(duration % 60).padStart(2, '0')
  return say(ob, chat, `🎙 <b>Voice answer received</b> (${m}:${s}). It’s stored privately with your onboarding, and your report can now begin. Thank you, ${esc(firstName(ob))}.`, { kind: 'system' })
}

// ---------- Webhook ----------
async function onUpdate(u: any) {
  const msg = u.message || u.edited_message
  if (!msg?.chat) return
  const chat = Number(msg.chat.id)
  const from = msg.from || {}
  const isFounder = Number(from.id) === FOUNDER
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  const text: string = (msg.text || msg.caption || '').trim()
  const cmd = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : ''
  const arg = text.split(/\s+/).slice(1).join(' ').trim()

  if (!isGroup) {
    if (isFounder) await tg('sendMessage', { chat_id: chat, text: 'Maktoub companion. Create a group with your client, add me, then send /link CODE in the group (code from the onboarding console).' })
    return
  }

  // A group upgraded to a supergroup gets a new id; follow it.
  if (msg.migrate_to_chat_id) {
    await db.from('maktoub_onboarding').update({ companion_chat_id: msg.migrate_to_chat_id }).eq('companion_chat_id', chat)
    return
  }

  if (cmd === '/link') {
    if (!isFounder) return tg('sendMessage', { chat_id: chat, text: 'Only Maktoub can link this group.' })
    const code = arg.toUpperCase().replace(/[^A-Z0-9]/g, '')
    const { data: ob } = code ? await db.from('maktoub_onboarding').select('*').eq('companion_link_code_hash', await sha256('link:' + code)).maybeSingle() : { data: null }
    if (!ob || ob.revoked_at || !ob.companion_link_expires_at || Date.parse(ob.companion_link_expires_at) < Date.now()) {
      return tg('sendMessage', { chat_id: chat, text: 'That code is not valid or has expired. Create a new one in the console.' })
    }
    const { data: clash } = await db.from('maktoub_onboarding').select('id').eq('companion_chat_id', chat).neq('id', ob.id).maybeSingle()
    if (clash) return tg('sendMessage', { chat_id: chat, text: 'This group is already linked to another client.' })
    const linked = await patch(ob, { companion_chat_id: chat, companion_linked_at: new Date().toISOString(), companion_link_code_hash: null, companion_link_expires_at: null, companion_paused_at: null })
    event(linked, 'companion_linked', { chat_id: chat })
    await say(linked, chat, [
      `<b>Assalamu alaikum ${esc(firstName(linked))}.</b>`,
      '',
      'This is your private Maktoub space. Only you, Deena and I are here.',
      '',
      'Each morning at 9 I’ll send one short reflection. Answer in a few lines or a voice note, whenever the day allows. Showing up is the whole practice; there are no wrong answers.',
      ...(voiceOutstanding(linked) ? ['', '🎙 Your onboarding voice answer can come later. When it’s ready, send it here as a voice note (about two minutes) and I’ll file it for you.'] : []),
      '',
      'Your portal has your agreement, updates and invoice.',
    ].join('\n'), { kind: 'system', button: ['Open my portal', PORTAL] })
    // Start the process straight away rather than waiting for tomorrow morning.
    if (linked.companion_day === 0) await sendPrompt(linked)
    return
  }

  const { data: ob } = await db.from('maktoub_onboarding').select('*').eq('companion_chat_id', chat).maybeSingle()
  if (!ob) return

  // Someone joined: the first person who isn't the founder or a bot is the client.
  if (Array.isArray(msg.new_chat_members)) {
    for (const m of msg.new_chat_members) {
      if (m.is_bot || Number(m.id) === FOUNDER) continue
      if (!ob.companion_client_tg_id) {
        await patch(ob, { companion_client_tg_id: m.id, companion_client_tg_name: [m.first_name, m.last_name].filter(Boolean).join(' ').slice(0, 120) })
        event(ob, 'companion_client_joined', {})
        await say(ob, chat, `Welcome, ${esc(firstName(ob))}. 🤍 Today’s reflection is just above. Reply whenever you’re ready.`, { kind: 'system' })
      }
    }
    return
  }

  let role: 'client' | 'founder' | 'other' = isFounder ? 'founder' : 'other'
  if (!isFounder && !from.is_bot) {
    if (!ob.companion_client_tg_id) {
      await patch(ob, { companion_client_tg_id: from.id, companion_client_tg_name: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 120) })
      ob.companion_client_tg_id = from.id
    }
    if (Number(from.id) === Number(ob.companion_client_tg_id)) role = 'client'
  }

  if (cmd) {
    await log(ob, chat, role, 'command', text)
    if (cmd === '/status' || cmd === '/progress') {
      const lines = [
        `<b>${esc(firstName(ob))} · ${esc(ob.reference_code)}</b>`,
        `Process day ${ob.companion_day} · streak ${ob.companion_streak}`,
        `Voice answer: ${ob.voice_submitted_at ? 'received ✓' : 'still to come'}`,
        `Payment: ${ob.payment_verified_at ? 'verified ✓' : ob.payment_reported_at ? 'being verified' : 'pending'}`,
        `Report: ${ob.report_delivered_at ? 'delivered ✓' : ob.report_due_at ? 'due ' + new Date(ob.report_due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' }) : 'not started'}`,
      ]
      return say(ob, chat, lines.join('\n'), { kind: 'system' })
    }
    if (cmd === '/today') return ob.companion_day ? sendPrompt(ob, true) : sendPrompt(ob)
    if (cmd === '/next' && isFounder) return sendPrompt(ob)
    if (cmd === '/pause' && isFounder) { await patch(ob, { companion_paused_at: new Date().toISOString() }); return say(ob, chat, 'Paused. No reflections until /resume.', { kind: 'system' }) }
    if (cmd === '/resume' && isFounder) { await patch(ob, { companion_paused_at: null }); return say(ob, chat, 'Resumed. Next reflection tomorrow at 9.', { kind: 'system' }) }
    if (cmd === '/help' || cmd === '/start') return say(ob, chat, 'Reply to each morning’s reflection in words or a voice note.\n/today repeats today’s reflection\n/status shows your progress' + (isFounder ? '\n\nFounder: /next sends the next reflection now · /pause · /resume' : ''), { kind: 'system' })
    return
  }

  const audio = msg.voice || msg.audio
  if (role === 'client' && audio && voiceOutstanding(ob) && ob.intake_submitted_at) {
    await log(ob, chat, role, 'voice', `[voice ${audio.duration || 0}s]`)
    try { await saveVoice(ob, chat, audio) } catch (e) {
      console.error('telegram voice save failed', e)
      await say(ob, chat, 'I couldn’t save that one. Please try once more, or record it on your portal.', { kind: 'system', button: ['Open my portal', PORTAL] })
    }
    return
  }

  const content = text || (audio ? `[voice ${audio.duration || 0}s]` : msg.photo ? '[photo]' : msg.document ? '[file]' : null)
  if (!content) return
  if (role !== 'client') { await log(ob, chat, role, audio ? 'voice' : 'message', content); return }

  // Client reply: the first one after today's prompt counts for accountability.
  const answering = awaitingReply(ob)
  await log(ob, chat, 'client', answering ? 'reply' : (audio ? 'voice' : 'message'), content)
  if (answering) {
    const streak = (ob.companion_streak || 0) + 1
    await patch(ob, { companion_last_reply_at: new Date().toISOString(), companion_streak: streak })
    const ack = ACKS[(ob.companion_day + streak) % ACKS.length]
    await say(ob, chat, streak >= 3 ? `${ack}\n<i>${streak} days in a row.</i>` : ack, { kind: 'system' })
  } else {
    await patch(ob, { companion_last_reply_at: new Date().toISOString() })
  }
}

// ---------- Internal actions ----------
async function internal(body: any) {
  if (body?.action === 'daily') return { results: await daily() }
  if (body?.action === 'setup') {
    const secret = await config('companion_webhook_secret')
    if (!secret) throw new Error('companion_webhook_secret missing')
    await tg('setWebhook', { url: SELF_URL, secret_token: secret, allowed_updates: ['message', 'edited_message'], drop_pending_updates: false })
    const me = await tg('getMe', {})
    return { ok: true, bot_username: me.username, can_read_all_group_messages: me.can_read_all_group_messages }
  }
  if (body?.action === 'portal_message' && typeof body.message_id === 'string') {
    const { data: m } = await db.from('maktoub_onboarding_messages').select('id,onboarding_id,title').eq('id', body.message_id).maybeSingle()
    if (!m) return { ok: false, reason: 'message not found' }
    const { data: ob } = await db.from('maktoub_onboarding').select('*').eq('id', m.onboarding_id).maybeSingle()
    if (!ob?.companion_chat_id) return { ok: false, reason: 'no linked Telegram group' }
    try {
      await say(ob, Number(ob.companion_chat_id), `📩 <b>${esc(firstName(ob))}, there’s a new message for you on your Maktoub portal.</b>${m.title ? '\n' + esc(m.title) : ''}`, { kind: 'system', button: ['Read it', PORTAL] })
      await db.from('maktoub_onboarding_messages').update({ telegram_sent_at: new Date().toISOString(), telegram_error: null }).eq('id', m.id)
      return { ok: true }
    } catch (e) {
      await db.from('maktoub_onboarding_messages').update({ telegram_error: String(e).slice(0, 300) }).eq('id', m.id)
      return { ok: false, reason: String(e).slice(0, 300) }
    }
  }
  if (body?.action === 'nudge' && typeof body.onboarding_id === 'string') {
    const { data: ob } = await db.from('maktoub_onboarding').select('*').eq('id', body.onboarding_id).maybeSingle()
    if (!ob?.companion_chat_id) return { ok: false, reason: 'no linked Telegram group' }
    await sendPrompt(ob)
    return { ok: true }
  }
  return { ok: false, reason: 'unknown action' }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok')
  const tgSecret = req.headers.get('x-telegram-bot-api-secret-token')
  if (tgSecret) {
    const expected = await config('companion_webhook_secret')
    if (!expected || tgSecret !== expected) return new Response('forbidden', { status: 403 })
    const update = await req.json().catch(() => null)
    // Always answer 200 so Telegram does not retry a message we have already handled or cannot handle.
    try { if (update) await onUpdate(update) } catch (e) { console.error('companion update failed', e) }
    return new Response('ok')
  }
  const notify = await config('notify_secret')
  if (!notify || req.headers.get('x-notify-secret') !== notify) return new Response('forbidden', { status: 403 })
  try {
    return Response.json(await internal(await req.json().catch(() => ({}))))
  } catch (e) {
    console.error('companion internal failed', e)
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 })
  }
})
