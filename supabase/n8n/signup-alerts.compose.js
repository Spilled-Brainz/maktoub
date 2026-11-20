const j = $input.first().json;
if (!j || !j.outbox_id) return [];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const digits = String(j.booking_phone || j.phone || '').replace(/\D/g,'');
const first = String(j.name || '').trim().split(/\s+/)[0] || '';
const review = j.session_kind === 'report_review';
// The founder works from Thailand: show her local time next to the client's Riyadh time.
const thai = iso => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : '';
let text = '', button_label = '', button_url = '', route = 'notify';
const k = j.kind;
if (k === 'signup' || k === 'event_interest') {
  text = `<b>${k === 'event_interest' ? 'New Maktoub event interest' : 'New Maktoub signup'}</b>\n${esc(j.name)}\n📱 ${esc(j.phone)}\n🕒 ${esc(j.created_riyadh)} (Riyadh)\n${j.interests ? 'Interest: ' + esc(j.interests) + '\n' : ''}Source: ${esc(j.source)}`;
  button_label = 'Open CRM'; button_url = 'https://maktoub.app/login/';
} else if (k === 'booking_request') {
  text = `<b>${review ? 'Report review request · 90 min · approval needed' : 'Booking request · approval needed'}</b>\n${esc(j.name)}\n📱 ${esc(j.booking_phone)}\n📅 ${esc(j.starts_riyadh)} (Riyadh)\n🇹🇭 ${esc(thai(j.starts_at))} (your time)\n🕒 Requested ${esc(j.created_riyadh)}`;
  if (j.decision_url) { button_label = 'Review · Approve / Decline'; button_url = j.decision_url; }
  else text += `\nStatus: ${esc(j.booking_status)} (no action needed)`;
} else if (k === 'booking_declined') {
  const msg = review
    ? `Hi ${first}, we are unable to make that time for your report review. Please choose another time in your report, under Session notes.`
    : `Hi ${first}, thank you for your interest in Maktoub. Unfortunately we are unable to offer that time. You are welcome to request another slot at https://maktoub.app/book/`;
  text = `<b>${review ? 'Report review declined' : 'Booking declined'}</b>\n${esc(j.name)} · ${esc(j.starts_riyadh)} (Riyadh) · ${esc(thai(j.starts_at))} (your time)\nTap below to send them a WhatsApp reply (optional).`;
  button_label = 'Send WhatsApp reply'; button_url = `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
} else if (k === 'booking_approved') {
  if (j.booking_status === 'accepted') {
    route = 'calendar';
  } else {
    text = `<b>Approved booking skipped</b>\n${esc(j.name)} · status is now ${esc(j.booking_status)}; no Calendar event created.`;
  }
} else if (k === 'onboarding_signed' || k === 'onboarding_submitted' || k === 'onboarding_payment_reported') {
  const title = { onboarding_signed: 'Onboarding · agreement signed ✍️', onboarding_submitted: 'Onboarding · details and voice note submitted 🎙', onboarding_payment_reported: 'Onboarding · transfer reported 💳 check your bank' }[k];
  text = `<b>${title}</b>\n${esc(j.name)} · ${esc(j.onboarding_ref)}\n📱 ${esc(j.phone)}\nStatus: ${esc(j.onboarding_status)}\n🕒 ${esc(j.created_riyadh)} (Riyadh)`;
  if (k === 'onboarding_submitted' && j.voice_url) {
    const s = Number(j.voice_seconds || 0);
    text += `\n🎧 <a href="${esc(j.voice_url)}">Listen to her voice note</a> (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}, link valid 7 days)`;
  }
  button_label = k === 'onboarding_payment_reported' ? 'Open · verify payment' : 'Open her record';
  button_url = j.console_url || 'https://maktoub.app/onboard/admin/';
} else {
  text = `<b>Maktoub alert: ${esc(k)}</b>\n${esc(j.name)}\n🕒 ${esc(j.created_riyadh)} (Riyadh)`;
  button_label = 'Open CRM'; button_url = 'https://maktoub.app/login/';
}
const out = { ...j, text, button_label, button_url, route };
if (route === 'calendar') {
  out.event_id = 'mk' + String(j.booking_id).replace(/-/g, '');
  out.calendar_body = {
    id: out.event_id,
    summary: review ? `Maktoub report review · ${j.name}` : `Maktoub intake · ${j.name}`,
    description: review ? `WhatsApp: ${j.booking_phone}\nBooked from the client's report (90 minutes)` : `WhatsApp: ${j.booking_phone}\nRequested via maktoub.app/book/`,
    start: { dateTime: j.starts_at, timeZone: 'Asia/Riyadh' },
    end: { dateTime: j.ends_at, timeZone: 'Asia/Riyadh' },
    conferenceData: { createRequest: { requestId: String(j.booking_id), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    reminders: { useDefault: true }
  };
}
return [{ json: out }];
