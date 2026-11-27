// Maktoub Lumi: the conversation engine shared by the founder and client pages.
// It never talks to the model itself: every request goes to the maktoub-companion edge function.
(() => {
'use strict';
const $ = id => document.getElementById(id);
const el = (t, cls, txt) => { const x = document.createElement(t); if (cls) x.className = cls; if (txt != null) x.textContent = String(txt); return x; };
const RTL = /[֐-ࣿ]/;
const when = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' });

// A small, safe renderer: paragraphs, line breaks, **bold**, *italic*. Text is escaped first.
function render(node, text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  node.innerHTML = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => '<p>' + inline(p).replace(/\n/g, '<br>') + '</p>').join('');
  const ar = RTL.test(text.slice(0, 200)); node.dir = ar ? 'rtl' : 'auto'; node.lang = ar ? 'ar' : '';
}

window.MaktoubChat = function (opts) {
  // opts: call(action, extra) → JSON; post(extra) → Response; label(thread) → [chip, title];
  //       empty: { title, body } for a thread with no messages; onThreads(threads)
  const log = $('log'), col = $('col'), form = $('form'), input = $('input'), sendBtn = $('sendBtn');
  const S = { threads: [], current: null, busy: false };

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const add = (role, text, who) => {
    const m = el('div', 'c-msg ' + role + (who ? ' by-' + who : '')), b = el('div', 'c-bubble');
    if (role === 'assistant') render(b, text); else { b.textContent = text; b.dir = 'auto'; }
    if (who && opts.speaker) m.append(el('span', 'c-who', opts.speaker(who)));
    m.append(b); col.append(m); return b;
  };

  function paintThreads() {
    const box = $('threads'); box.textContent = '';
    if (!S.threads.length) { box.append(el('p', 'c-side-foot', 'No conversations yet.')); }
    for (const t of S.threads) {
      const [chip] = opts.label(t);
      const b = el('button', 'c-thread' + (S.current && t.id === S.current.id ? ' on' : ''));
      b.append(el('b', null, t.title), el('span', null, chip + ' · ' + when(t.updated_at)));
      b.onclick = () => { open(t.id); $('side').classList.remove('open'); };
      box.append(b);
    }
    opts.onThreads && opts.onThreads(S.threads);
  }

  function paintHead() {
    const t = S.current;
    $('head').hidden = !t;
    if (!t) return;
    const [chip, title] = opts.label(t);
    const h = $('title'); h.textContent = ''; h.append(el('span', 'c-chip', chip), document.createTextNode(title));
    $('meta').textContent = t.context_read_at ? 'Context read ' + when(t.context_read_at) : '';
    $('del').hidden = !!(opts.canDelete && !opts.canDelete(t));
  }

  function showEmpty() {
    col.textContent = '';
    const e = el('div', 'c-empty'), cfg = opts.empty(S.current);
    e.append(el('h2', null, cfg.title)); (Array.isArray(cfg.body) ? cfg.body : [cfg.body]).forEach(p => e.append(el('p', null, p)));
    col.append(e);
  }

  async function refresh() {
    const j = await opts.call('load');
    S.threads = j.threads || [];
    paintThreads();
    return j;
  }

  async function open(id) {
    const j = await opts.call('get', { thread_id: id });
    S.current = { ...(S.threads.find(t => t.id === id) || {}), ...j.thread };
    opts.onOpen && opts.onOpen(S.current);
    paintThreads(); paintHead();
    col.textContent = '';
    if (!j.messages.length) showEmpty(); else j.messages.forEach(m => add(m.role, m.text, m.speaker));
    const ro = !!(opts.readOnly && opts.readOnly(S.current));
    form.hidden = ro; $('ro').hidden = !ro;
    if (!ro) input.focus({ preventScroll: true });
    scroll();
  }

  async function start(extra) {
    const j = await opts.call('open', extra);
    S.threads.unshift(j.thread);
    await open(j.thread.id);
  }

  async function send(text) {
    if (S.busy || !S.current) return;
    S.busy = true; sendBtn.disabled = true;
    if (col.querySelector('.c-empty')) col.textContent = '';
    add('user', text);
    const bubble = add('assistant', ''); bubble.append(el('span', 'c-wait'));
    scroll();
    let acc = '', ended = false;
    try {
      const r = await opts.post({ action: 'send', thread_id: S.current.id, text });
      if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'The reply did not come through. Please try again.'); }
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.t === 'd') { acc += ev.x; render(bubble, acc); const near = log.scrollHeight - log.scrollTop - log.clientHeight < 160; if (near) scroll(); }
          else if (ev.t === 'done') { ended = true; if (ev.truncated) add('note', 'The reply reached its length limit. Ask it to continue.'); }
          else if (ev.t === 'refused') { ended = true; bubble.parentNode.remove(); add('note', ev.x); }
          else if (ev.t === 'error') throw new Error(ev.x);
        }
      }
      if (!ended) throw new Error('The connection dropped. Please send your message again.');
      const t = S.threads.find(x => x.id === S.current.id);
      if (t) { if (t.title === 'New conversation') t.title = text.replace(/\s+/g, ' ').slice(0, 70); t.updated_at = new Date().toISOString(); S.threads.sort((a, b) => b.updated_at.localeCompare(a.updated_at)); paintThreads(); }
    } catch (e) {
      bubble.parentNode.remove();
      col.lastChild && col.lastChild.classList.contains('user') && col.lastChild.remove();
      add('err', e.message);
      input.value = input.value || text; grow();
    } finally {
      S.busy = false; sendBtn.disabled = false; scroll();
    }
  }

  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover:hover)').matches) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', e => { e.preventDefault(); const text = input.value.trim(); if (!text || S.busy) return; input.value = ''; grow(); send(text); });
  $('del').onclick = async () => {
    if (!S.current || !confirm('Delete this conversation permanently? This cannot be undone.')) return;
    await opts.call('delete', { thread_id: S.current.id });
    S.threads = S.threads.filter(t => t.id !== S.current.id); S.current = null;
    paintThreads(); paintHead(); form.hidden = true; $('ro').hidden = true; col.textContent = ''; opts.idle && opts.idle(col);
  };
  $('menu').onclick = () => $('side').classList.toggle('open');

  // Clears the conversation area so a page can show something else there (the founder's check-ins).
  const clear = () => { S.current = null; paintThreads(); paintHead(); form.hidden = true; $('ro').hidden = true; col.textContent = ''; return col; };
  return { refresh, open, start, clear, state: S, idle: () => { clear(); opts.idle && opts.idle(col); } };
};
window.MaktoubChat.el = el;
})();
