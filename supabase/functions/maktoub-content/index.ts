// Maktoub content bot. Text an idea to a private Telegram bot; Claude turns it into a native post for each
// platform; buttons approve, schedule, toggle platforms, rewrite or discard; pg_cron publishes what is due.
//
// Three callers:
//   Telegram webhook   header X-Telegram-Bot-Api-Secret-Token = CONTENT_WEBHOOK_SECRET
//   pg_cron scheduler  header x-notify-secret = maktoub_internal_config('notify_secret'), body {"action":"publish_due"}
//   one-off setup      same secret, body {"action":"set_webhook"} registers this function with Telegram
//
// A platform with no credentials is never skipped silently: at publish time its text arrives in Telegram,
// ready to paste. Instagram needs a photo, so send the idea as a photo caption when you want it posted there.
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const env = (k: string, d = '') => Deno.env.get(k) || d
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
const anthropic = new Anthropic() // ANTHROPIC_API_KEY
const BOT = env('MAKTOUB_CONTENT_BOT_TOKEN')
const OWNER = env('MAKTOUB_TELEGRAM_CHAT_ID', '970663486')
const HOOK_SECRET = env('CONTENT_WEBHOOK_SECRET')
const SELF_URL = `${env('SUPABASE_URL')}/functions/v1/maktoub-content`
const DEFAULT_HOUR = Number(env('CONTENT_DEFAULT_HOUR', '9')) // Riyadh time
const RIYADH_OFFSET_H = 3 // Riyadh is UTC+3 all year

type Platform = 'linkedin' | 'instagram' | 'threads' | 'facebook' | 'x'
const ALL: Platform[] = ['linkedin', 'instagram', 'threads', 'facebook', 'x']
const NAMES: Record<Platform, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', threads: 'Threads', facebook: 'Facebook', x: 'X' }
const DEFAULT_PLATFORMS = env('CONTENT_PLATFORMS', ALL.join(',')).split(',').map(s => s.trim()).filter((p): p is Platform => ALL.includes(p as Platform))

type Drafts = { linkedin: string; instagram: string; threads: string; facebook: string; x: string[] }
type Post = {
  id: string; source_text: string; feedback: string[]; image_path: string | null; drafts: Drafts; platforms: Platform[]
  status: string; publish_at: string | null; suggested_at: string | null; control_message_id: number | null; results: Record<string, any>
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const riyadh = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })
const short = (id: string) => id.slice(0, 6)

// ---------- Telegram ----------
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) console.error('telegram', method, r.status, JSON.stringify(j).slice(0, 300))
  return j.result
}
const say = (text: string, extra: Record<string, unknown> = {}) =>
  tg('sendMessage', { chat_id: OWNER, text: text.slice(0, 4090), parse_mode: 'HTML', disable_web_page_preview: true, ...extra })

// ---------- Claude ----------
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['linkedin', 'instagram', 'threads', 'facebook', 'x', 'publish_at'],
  properties: {
    linkedin: { type: 'string', description: 'LinkedIn post, max 3000 characters' },
    instagram: { type: 'string', description: 'Instagram caption, max 2200 characters, hashtags (if any) at the end' },
    threads: { type: 'string', description: 'Threads post, max 500 characters' },
    facebook: { type: 'string', description: 'Facebook post' },
    x: { type: 'array', items: { type: 'string' }, description: 'X posts; one item unless a short thread serves the idea better (max 5). Each item max 270 characters' },
    publish_at: { type: 'string', description: 'If the message asks for a posting time, that time as ISO 8601 with offset; otherwise empty string' },
  },
}

const BASE_VOICE = `You turn the founder's raw idea into posts for each social platform. The founder thinks across psychology, relationships, spirituality and science; the audience is intelligent and allergic to self-help clichés.

Keep the founder's meaning and, where they are good, their exact words. Never invent facts, statistics, quotes, clients or stories. If the idea says "Example" or implies one without giving it, write one concrete, everyday illustration that is plainly hypothetical (no "a client of mine...").

Write each platform natively rather than resizing one text:
LinkedIn: a strong first line that stands alone above the fold, short paragraphs, one clear idea developed, ends with a question or a line that lands. No hashtag pile; at most three at the end.
Instagram: the caption to sit under an image. A hook line, the idea in a few short paragraphs, three to eight relevant hashtags at the very end.
Threads: conversational and compact, under 500 characters, no hashtags.
Facebook: warm, slightly longer and more personal, no hashtags.
X: sharp. One post if the idea fits; otherwise a thread of at most five posts, each standing on its own and under 270 characters, no hashtags, no numbering.

No em-dash-heavy rhythm, no "Here's the thing", no "Let that sink in", no emoji unless the house voice asks for them. Plain text only: no markdown, no asterisks.`

async function generate(post: Pick<Post, 'source_text' | 'feedback'>, hasImage: boolean): Promise<{ drafts: Drafts; suggested_at: string | null }> {
  const { data: v } = await db.from('maktoub_internal_config').select('value').eq('key', 'content_voice').maybeSingle()
  const system = BASE_VOICE + (v?.value ? `\n\nHouse voice from the founder (follows and overrides the above):\n${v.value}` : '')
  const nowRiyadh = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Riyadh' })
  let content = `Current time: ${nowRiyadh} (Asia/Riyadh, UTC+03:00).${hasImage ? ' A photo accompanies this post.' : ''}\n\nThe founder's idea:\n<idea>\n${post.source_text}\n</idea>`
  if (post.feedback.length) content += `\n\nRewrite notes from the founder, apply all of them, the latest wins on conflict:\n${post.feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`

  const res: any = await anthropic.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system,
    messages: [{ role: 'user', content }],
  } as any)
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this one' + (res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ''))
  if (res.stop_reason === 'max_tokens') throw new Error('the draft ran too long; try again')
  const text = res.content.find((b: any) => b.type === 'text')?.text
  const out = JSON.parse(text)
  const at = out.publish_at ? new Date(out.publish_at) : null
  return {
    drafts: { linkedin: out.linkedin, instagram: out.instagram, threads: out.threads, facebook: out.facebook, x: (out.x as string[]).slice(0, 5) },
    suggested_at: at && !isNaN(+at) && +at > Date.now() ? at.toISOString() : null,
  }
}

// ---------- Drafts in Telegram ----------
function nextSlot(): string {
  const r = new Date(Date.now() + RIYADH_OFFSET_H * 3600e3) // wall clock in Riyadh, read with UTC getters
  const slot = Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate(), DEFAULT_HOUR) - RIYADH_OFFSET_H * 3600e3
  return new Date(slot > Date.now() + 10 * 60e3 ? slot : slot + 24 * 3600e3).toISOString()
}
const scheduleFor = (p: Post) => p.suggested_at && +new Date(p.suggested_at) > Date.now() ? p.suggested_at : nextSlot()

function controlText(p: Post) {
  const head = `<b>Draft ${short(p.id)}</b>`
  const where = p.platforms.length ? p.platforms.map(x => NAMES[x]).join(' · ') : 'no platforms selected'
  const status: Record<string, string> = {
    draft: 'Reply to this message with notes to rewrite, or choose below.',
    scheduled: `🕘 Scheduled for ${esc(riyadh(p.publish_at!))} (Riyadh).`,
    publishing: '⏳ Publishing…',
    discarded: '🗑 Discarded.',
  }
  const igNote = p.platforms.includes('instagram') && !p.image_path ? '\n<i>Instagram needs a photo, so its caption will come here to paste.</i>' : ''
  return `${head}\n${where}${igNote}\n\n${status[p.status] ?? p.status}`
}

function keyboard(p: Post) {
  if (p.status === 'scheduled') return { inline_keyboard: [[{ text: '🚀 Publish now', callback_data: `now:${p.id}` }, { text: '↩️ Unschedule', callback_data: `uns:${p.id}` }]] }
  if (p.status !== 'draft') return { inline_keyboard: [] }
  const toggles = ALL.map(x => ({ text: `${p.platforms.includes(x) ? '✓' : '·'} ${NAMES[x]}`, callback_data: `tog:${p.id}:${x}` }))
  return {
    inline_keyboard: [
      toggles.slice(0, 3), toggles.slice(3),
      [{ text: '🚀 Publish now', callback_data: `now:${p.id}` }, { text: `🕘 ${riyadh(scheduleFor(p))}`, callback_data: `sch:${p.id}` }],
      [{ text: '🔁 Rewrite', callback_data: `red:${p.id}` }, { text: '🗑 Discard', callback_data: `del:${p.id}` }],
    ],
  }
}

async function showDrafts(p: Post) {
  for (const x of ALL) {
    const body = x === 'x' ? p.drafts.x.map((t, i) => (p.drafts.x.length > 1 ? `${i + 1}/${p.drafts.x.length}\n` : '') + t).join('\n\n') : p.drafts[x]
    await say(`<b>${NAMES[x]}</b>\n\n${esc(body)}`)
  }
  const m = await say(controlText(p), { reply_markup: keyboard(p) })
  if (m?.message_id) await db.from('maktoub_content_posts').update({ control_message_id: m.message_id }).eq('id', p.id)
}

async function refreshControl(p: Post) {
  if (!p.control_message_id) return
  await tg('editMessageText', { chat_id: OWNER, message_id: p.control_message_id, text: controlText(p), parse_mode: 'HTML', reply_markup: keyboard(p) })
}

const load = async (id: string) => (await db.from('maktoub_content_posts').select('*').eq('id', id).maybeSingle()).data as Post | null

// ---------- Publishing ----------
function pct(s: string) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) }

async function xOauthHeader(method: string, url: string) {
  const o: Record<string, string> = {
    oauth_consumer_key: env('X_API_KEY'), oauth_nonce: crypto.randomUUID().replace(/-/g, ''), oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: env('X_ACCESS_TOKEN'), oauth_version: '1.0',
  }
  const params = Object.keys(o).sort().map(k => `${pct(k)}=${pct(o[k])}`).join('&')
  const base = `${method}&${pct(url)}&${pct(params)}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${pct(env('X_API_SECRET'))}&${pct(env('X_ACCESS_SECRET'))}`), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)))))
  o.oauth_signature = sig
  return 'OAuth ' + Object.keys(o).sort().map(k => `${pct(k)}="${pct(o[k])}"`).join(', ')
}

async function form(url: string, params: Record<string, string>) {
  const r = await fetch(url, { method: 'POST', body: new URLSearchParams(params) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.error) throw new Error(`${r.status} ${j.error?.message ?? JSON.stringify(j).slice(0, 200)}`)
  return j
}
async function waitReady(url: string, field: string) {
  for (let i = 0; i < 12; i++) {
    const j = await (await fetch(url)).json().catch(() => ({}))
    if (j[field] === 'FINISHED') return
    if (j[field] === 'ERROR') throw new Error('media processing failed')
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error('media still processing after 60s')
}

const GRAPH_V = env('META_GRAPH_VERSION', 'v21.0')
const ADAPTERS: Record<Platform, { ready: () => boolean; publish: (text: string, image: string | null, thread?: string[]) => Promise<{ url?: string; id?: string }> }> = {
  threads: {
    ready: () => !!(env('THREADS_USER_ID') && env('THREADS_ACCESS_TOKEN')),
    async publish(text, image) {
      const base = `https://graph.threads.net/v1.0/${env('THREADS_USER_ID')}`, token = env('THREADS_ACCESS_TOKEN')
      const c = await form(`${base}/threads`, { media_type: image ? 'IMAGE' : 'TEXT', text, ...(image ? { image_url: image } : {}), access_token: token })
      if (image) await waitReady(`https://graph.threads.net/v1.0/${c.id}?fields=status&access_token=${token}`, 'status')
      const p = await form(`${base}/threads_publish`, { creation_id: c.id, access_token: token })
      const link = await (await fetch(`https://graph.threads.net/v1.0/${p.id}?fields=permalink&access_token=${token}`)).json().catch(() => ({}))
      return { id: p.id, url: link.permalink }
    },
  },
  instagram: {
    ready: () => !!(env('INSTAGRAM_USER_ID') && env('INSTAGRAM_ACCESS_TOKEN')),
    async publish(text, image) {
      if (!image) throw new Error('needs a photo')
      const host = env('INSTAGRAM_GRAPH_HOST', 'graph.instagram.com'), token = env('INSTAGRAM_ACCESS_TOKEN')
      const base = `https://${host}/${GRAPH_V}/${env('INSTAGRAM_USER_ID')}`
      const c = await form(`${base}/media`, { image_url: image, caption: text, access_token: token })
      await waitReady(`https://${host}/${GRAPH_V}/${c.id}?fields=status_code&access_token=${token}`, 'status_code')
      const p = await form(`${base}/media_publish`, { creation_id: c.id, access_token: token })
      const link = await (await fetch(`https://${host}/${GRAPH_V}/${p.id}?fields=permalink&access_token=${token}`)).json().catch(() => ({}))
      return { id: p.id, url: link.permalink }
    },
  },
  facebook: {
    ready: () => !!(env('FACEBOOK_PAGE_ID') && env('FACEBOOK_PAGE_TOKEN')),
    async publish(text, image) {
      const base = `https://graph.facebook.com/${GRAPH_V}/${env('FACEBOOK_PAGE_ID')}`, token = env('FACEBOOK_PAGE_TOKEN')
      const p = image ? await form(`${base}/photos`, { url: image, caption: text, access_token: token }) : await form(`${base}/feed`, { message: text, access_token: token })
      const id = p.post_id ?? p.id
      return { id, url: `https://www.facebook.com/${id}` }
    },
  },
  linkedin: {
    ready: () => !!(env('LINKEDIN_ACCESS_TOKEN') && env('LINKEDIN_AUTHOR_URN')),
    async publish(text) {
      // LinkedIn's "little text" format treats these characters as markup; escape them so the text posts as written.
      const commentary = text.replace(/[\\|{}@\[\]()<>#*_~]/g, c => '\\' + c)
      const r = await fetch('https://api.linkedin.com/rest/posts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('LINKEDIN_ACCESS_TOKEN')}`, 'Content-Type': 'application/json', 'LinkedIn-Version': env('LINKEDIN_VERSION', '202510'), 'X-Restli-Protocol-Version': '2.0.0' },
        body: JSON.stringify({
          author: env('LINKEDIN_AUTHOR_URN'), commentary, visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        }),
      })
      if (r.status !== 201) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
      const id = r.headers.get('x-restli-id') ?? ''
      return { id, url: id ? `https://www.linkedin.com/feed/update/${id}` : undefined }
    },
  },
  x: {
    ready: () => !!(env('X_API_KEY') && env('X_API_SECRET') && env('X_ACCESS_TOKEN') && env('X_ACCESS_SECRET')),
    async publish(_text, _image, thread = []) {
      const url = 'https://api.x.com/2/tweets'
      let first = '', prev = ''
      for (const t of thread) {
        const r = await fetch(url, {
          method: 'POST', headers: { Authorization: await xOauthHeader('POST', url), 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: t, ...(prev ? { reply: { in_reply_to_tweet_id: prev } } : {}) }),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}` + (first ? ' (thread partly posted)' : ''))
        prev = j.data.id
        first ||= prev
      }
      return { id: first, url: `https://x.com/i/status/${first}` }
    },
  },
}

async function publish(p: Post) {
  const image = p.image_path ? (await db.storage.from('maktoub-content').createSignedUrl(p.image_path, 3600)).data?.signedUrl ?? null : null
  const results: Record<string, any> = { ...p.results }
  const manual: string[] = []
  for (const x of p.platforms) {
    if (results[x]?.ok) continue // already went out on an earlier attempt
    const text = x === 'x' ? p.drafts.x.join('\n\n') : p.drafts[x]
    const a = ADAPTERS[x]
    if (!a.ready() || (x === 'instagram' && !image)) { results[x] = { ok: true, manual: true }; manual.push(x); continue }
    try { results[x] = { ok: true, ...(await a.publish(text, image, p.drafts.x)) } } catch (e) { results[x] = { ok: false, error: String((e as Error).message ?? e) } }
  }
  const failed = p.platforms.filter(x => !results[x]?.ok)
  const status = failed.length === 0 ? 'published' : failed.length === p.platforms.length ? 'failed' : 'partial'
  await db.from('maktoub_content_posts').update({ status, results }).eq('id', p.id)

  for (const x of manual) {
    const body = x === 'x' ? p.drafts.x.join('\n\n— — —\n\n') : p.drafts[x]
    await say(`📋 <b>${NAMES[x]}</b>, ready to paste (${short(p.id)})\n\n${esc(body)}`)
  }
  const lines = p.platforms.map(x => {
    const r = results[x]
    if (r?.manual) return `📋 ${NAMES[x]}: sent above to paste`
    if (r?.ok) return `✅ ${NAMES[x]}${r.url ? `: <a href="${esc(r.url)}">view</a>` : ''}`
    return `❌ ${NAMES[x]}: ${esc(r?.error)}`
  })
  const retry = failed.length ? { reply_markup: { inline_keyboard: [[{ text: '🔁 Retry failed', callback_data: `now:${p.id}` }]] } } : {}
  await say(`<b>Draft ${short(p.id)}: ${status}</b>\n${lines.join('\n')}`, retry)
  if (p.control_message_id) await tg('editMessageReplyMarkup', { chat_id: OWNER, message_id: p.control_message_id, reply_markup: { inline_keyboard: [] } })
}

// Claim posts atomically so the scheduler and a "Publish now" tap can never post the same thing twice.
async function claimAndPublish(id?: string) {
  let q = db.from('maktoub_content_posts').update({ status: 'publishing' })
  q = id ? q.eq('id', id).in('status', ['draft', 'scheduled', 'partial', 'failed']) : q.eq('status', 'scheduled').lte('publish_at', new Date().toISOString())
  const { data } = await q.select('*')
  for (const p of (data ?? []) as Post[]) {
    try { await publish(p) } catch (e) {
      console.error('publish', p.id, e)
      await db.from('maktoub_content_posts').update({ status: 'failed' }).eq('id', p.id)
      await say(`❌ Draft ${short(p.id)} could not publish: ${esc((e as Error).message)}`)
    }
  }
  return data?.length ?? 0
}

// ---------- Incoming messages ----------
async function newIdea(text: string, photoFileId: string | null) {
  const { data: row, error } = await db.from('maktoub_content_posts').insert({ source_text: text, platforms: DEFAULT_PLATFORMS }).select('*').single()
  if (error) throw error
  const p = row as Post
  if (photoFileId) {
    const f = await tg('getFile', { file_id: photoFileId })
    if (f?.file_path) {
      const bytes = await (await fetch(`https://api.telegram.org/file/bot${BOT}/${f.file_path}`)).arrayBuffer()
      const path = `${p.id}.jpg`
      const up = await db.storage.from('maktoub-content').upload(path, bytes, { contentType: 'image/jpeg', upsert: true })
      if (!up.error) p.image_path = path
    }
  }
  await tg('sendChatAction', { chat_id: OWNER, action: 'typing' })
  const g = await generate(p, !!p.image_path)
  Object.assign(p, g)
  await db.from('maktoub_content_posts').update({ drafts: p.drafts, suggested_at: p.suggested_at, image_path: p.image_path }).eq('id', p.id)
  await showDrafts(p)
}

async function rewrite(p: Post, note: string | null) {
  if (note) p.feedback = [...p.feedback, note]
  await tg('sendChatAction', { chat_id: OWNER, action: 'typing' })
  const g = await generate(p, !!p.image_path)
  p.drafts = g.drafts
  p.suggested_at = g.suggested_at ?? p.suggested_at
  if (p.control_message_id) await tg('editMessageReplyMarkup', { chat_id: OWNER, message_id: p.control_message_id, reply_markup: { inline_keyboard: [] } })
  await db.from('maktoub_content_posts').update({ drafts: p.drafts, feedback: p.feedback, suggested_at: p.suggested_at }).eq('id', p.id)
  await showDrafts(p)
}

const HELP = `<b>Content bot</b>
Text me an idea, in any state, and I draft it for ${DEFAULT_PLATFORMS.map(p => NAMES[p]).join(', ')}.
Send it as a photo caption to post the photo too (Instagram needs one).
Mention a time ("post Thursday 8pm") and I will offer it as the schedule.
Reply to a draft's button message with notes to rewrite it.

/queue  what is scheduled
/voice  show the house voice · <code>/voice your notes</code> to set it
/connected  which platforms post automatically`

async function onMessage(m: any) {
  const text: string = (m.text ?? m.caption ?? '').trim()
  const photo = m.photo?.length ? m.photo[m.photo.length - 1].file_id : null
  if (text === '/start' || text === '/help') return say(HELP)
  if (text === '/connected') return say(ALL.map(x => `${ADAPTERS[x].ready() ? '✅' : '📋'} ${NAMES[x]}${ADAPTERS[x].ready() ? '' : ' (copy-paste)'}`).join('\n'))
  if (text.startsWith('/voice')) {
    const v = text.slice(6).trim()
    if (v) { await db.from('maktoub_internal_config').upsert({ key: 'content_voice', value: v === 'clear' ? '' : v, updated_at: new Date().toISOString() }); return say(v === 'clear' ? 'House voice cleared.' : 'House voice saved. Every new draft follows it.') }
    const { data } = await db.from('maktoub_internal_config').select('value').eq('key', 'content_voice').maybeSingle()
    return say(data?.value ? `<b>House voice</b>\n${esc(data.value)}\n\n<code>/voice clear</code> to remove.` : 'No house voice yet. Set one: <code>/voice warm, precise, no emoji, speaks to women who think</code>')
  }
  if (text === '/queue') {
    const { data } = await db.from('maktoub_content_posts').select('id,publish_at,source_text').eq('status', 'scheduled').order('publish_at')
    if (!data?.length) return say('Nothing scheduled.')
    return say(data.map(p => `🕘 ${esc(riyadh(p.publish_at))}  <b>${short(p.id)}</b>\n${esc(p.source_text.slice(0, 80))}`).join('\n\n'))
  }
  const replyTo = m.reply_to_message?.message_id
  if (replyTo && text) {
    const { data } = await db.from('maktoub_content_posts').select('*').eq('control_message_id', replyTo).eq('status', 'draft').maybeSingle()
    if (data) return rewrite(data as Post, text)
  }
  if (!text && !photo) return
  if (!text) return say('Add a caption with the idea so I know what to write.')
  return newIdea(text, photo)
}

async function onCallback(c: any) {
  await tg('answerCallbackQuery', { callback_query_id: c.id })
  const [act, id, arg] = String(c.data).split(':')
  const p = await load(id)
  if (!p) return
  if (act === 'tog' && p.status === 'draft' && ALL.includes(arg as Platform)) {
    p.platforms = p.platforms.includes(arg as Platform) ? p.platforms.filter(x => x !== arg) : ALL.filter(x => x === arg || p.platforms.includes(x))
    await db.from('maktoub_content_posts').update({ platforms: p.platforms }).eq('id', p.id)
    return refreshControl(p)
  }
  if (act === 'sch' && p.status === 'draft') {
    if (!p.platforms.length) return say('Select at least one platform first.')
    p.status = 'scheduled'; p.publish_at = scheduleFor(p)
    await db.from('maktoub_content_posts').update({ status: p.status, publish_at: p.publish_at }).eq('id', p.id).eq('status', 'draft')
    return refreshControl(p)
  }
  if (act === 'uns' && p.status === 'scheduled') {
    p.status = 'draft'; p.publish_at = null
    await db.from('maktoub_content_posts').update({ status: 'draft', publish_at: null }).eq('id', p.id).eq('status', 'scheduled')
    return refreshControl(p)
  }
  if (act === 'now') {
    if (!p.platforms.length) return say('Select at least one platform first.')
    await db.from('maktoub_content_posts').update({ publish_at: new Date().toISOString() }).eq('id', p.id)
    return claimAndPublish(p.id)
  }
  if (act === 'red' && p.status === 'draft') return rewrite(p, null)
  if (act === 'del' && p.status === 'draft') {
    p.status = 'discarded'
    await db.from('maktoub_content_posts').update({ status: 'discarded' }).eq('id', p.id)
    return refreshControl(p)
  }
}

async function onUpdate(u: any) {
  const chat = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id
  if (String(chat) !== OWNER) return // private bot: the founder only
  try {
    if (u.callback_query) await onCallback(u.callback_query)
    else if (u.message) await onMessage(u.message)
  } catch (e) {
    console.error('update failed', e)
    await say(`Something went wrong: ${esc((e as Error).message ?? e)}`)
  }
}

Deno.serve(async (req) => {
  // Telegram webhook. Answer at once and work in the background, so a slow draft never makes Telegram resend.
  const tgSecret = req.headers.get('x-telegram-bot-api-secret-token')
  if (tgSecret !== null) {
    if (!HOOK_SECRET || tgSecret !== HOOK_SECRET) return new Response('forbidden', { status: 403 })
    const u = await req.json().catch(() => null)
    if (!u?.update_id) return new Response('ok')
    const { error } = await db.from('maktoub_content_updates').insert({ update_id: u.update_id })
    if (!error) EdgeRuntime.waitUntil(onUpdate(u)) // a duplicate id means Telegram is resending one we already have
    return new Response('ok')
  }

  const { data: cfg } = await db.from('maktoub_internal_config').select('value').eq('key', 'notify_secret').maybeSingle()
  if (!cfg?.value || req.headers.get('x-notify-secret') !== cfg.value) return new Response('forbidden', { status: 403 })
  const body = await req.json().catch(() => ({}))
  if (body.action === 'publish_due') return Response.json({ published: await claimAndPublish() })
  if (body.action === 'set_webhook') {
    const r = await tg('setWebhook', { url: SELF_URL, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true })
    await tg('setMyCommands', { commands: [
      { command: 'queue', description: 'What is scheduled' }, { command: 'voice', description: 'Show or set the house voice' },
      { command: 'connected', description: 'Which platforms post automatically' }, { command: 'help', description: 'How this works' },
    ] })
    return Response.json({ ok: r === true })
  }
  return Response.json({ error: 'unknown action' }, { status: 400 })
})
