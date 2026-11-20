const c = $('Compose').first().json;
const meet = $('Get Calendar event').first().json.hangoutLink;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const digits = String(c.booking_phone || c.phone || '').replace(/\D/g,'');
const first = String(c.name || '').trim().split(/\s+/)[0] || '';
const review = c.session_kind === 'report_review';
const msg = review
  ? `Hi ${first}, your Maktoub report review is confirmed for ${c.starts_riyadh} (Riyadh time), 90 minutes.\n\nJoin here: ${meet}\n\nThe link is also in your report, under Session notes. We look forward to going through it with you.`
  : `Hi ${first}, your Maktoub consultation is confirmed for ${c.starts_riyadh} (Riyadh time).\n\nJoin here: ${meet}\n\nWe look forward to speaking with you.`;
return [{ json: { ...c,
  text: `<b>${review ? 'Report review approved ✅' : 'Booking approved ✅'}</b>\n${esc(c.name)} · ${esc(c.starts_riyadh)} (Riyadh)\nMeet: ${esc(meet)}\nCalendar event created. Tap below to send the WhatsApp confirmation.`,
  button_label: 'Send WhatsApp confirmation',
  button_url: `https://wa.me/${digits}?text=${encodeURIComponent(msg)}` } }];
