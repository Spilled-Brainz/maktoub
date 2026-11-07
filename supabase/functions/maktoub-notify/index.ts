// Sends onboarding alerts straight to the founder's Telegram, without n8n.
// Called by a database trigger (pg_net) whenever an onboarding_* row lands in
// maktoub_notification_outbox. Each call sends every unsent onboarding alert,
// so a failed send is retried on the next event. Signup/booking alerts stay with n8n.
// Auth: x-notify-secret must equal the value in maktoub_internal_config('notify_secret').
import { createClient } from 'npm:@supabase/supabase-js@2'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const BOT = Deno.env.get('MAKTOUB_TELEGRAM_BOT_TOKEN') || ''
const CHAT = Deno.env.get('MAKTOUB_TELEGRAM_CHAT_ID') || '970663486'
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const riyadh = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })
const TITLES: Record<string, string> = {
  onboarding_signed: 'Agreement signed ✍️',
  onboarding_submitted: 'Details and voice note submitted 🎙',
  onboarding_payment_reported: 'Transfer reported 💳 check your bank',
}

async function send(text: string, url: string, label: string) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: label, url }]] } }),
  })
  if (!r.ok) throw new Error('telegram ' + r.status + ' ' + (await r.text()).slice(0, 200))
}

Deno.serve(async (req) => {
  const { data: cfg } = await db.from('maktoub_internal_config').select('value').eq('key', 'notify_secret').maybeSingle()
  if (!cfg?.value || req.headers.get('x-notify-secret') !== cfg.value) return new Response('forbidden', { status: 403 })
  if (!BOT) return Response.json({ ok: false, reason: 'MAKTOUB_TELEGRAM_BOT_TOKEN is not set' }, { status: 503 })
  const { data: rows, error } = await db.from('maktoub_notification_outbox').select('id,kind,event_id,created_at,person_id')
    .like('kind', 'onboarding_%').is('sent_at', null).order('created_at').limit(20)
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  const results: unknown[] = []
  for (const o of rows ?? []) {
    try {
      const { data: ob } = await db.from('maktoub_onboarding').select('id,reference_code,invited_name,invited_phone,signature_name,intake,is_test,payment_client_note').eq('id', o.event_id).maybeSingle()
      if (!ob || ob.is_test) { await db.from('maktoub_notification_outbox').update({ sent_at: new Date().toISOString() }).eq('id', o.id); continue }
      const name = ob.intake?.full_name || ob.signature_name || ob.invited_name
      let text = `<b>${TITLES[o.kind] || o.kind}</b>\n${esc(name)}\n📱 ${esc(ob.invited_phone)}\n🕒 ${esc(riyadh(o.created_at))} (Riyadh)`
      if (o.kind === 'onboarding_payment_reported' && ob.payment_client_note) text += `\n${esc(ob.payment_client_note)}`
      const label = o.kind === 'onboarding_payment_reported' ? 'Open · verify payment' : 'Open her record'
      await send(text, `https://maktoub.app/onboard/admin/#${ob.id}`, label)
      await db.from('maktoub_notification_outbox').update({ sent_at: new Date().toISOString() }).eq('id', o.id).is('sent_at', null)
      results.push({ id: o.id, sent: true })
    } catch (e) {
      console.error('notify failed', o.id, e)
      results.push({ id: o.id, sent: false })
    }
  }
  return Response.json({ ok: true, results })
})
