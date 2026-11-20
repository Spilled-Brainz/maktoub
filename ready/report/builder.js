/* Maktoub · voice report builder for the founder consoles (/ready/admin/ and /onboard/admin/).
   reportBuilder(report, ctx) returns the builder; assessmentView(list, instruments) shows scored tests.
   ctx: { open, clientName, reference, save: async ({ data, publish?, unpublish? }) => void, after?: async () => void }
   Needs /ready/report/emowave.js loaded first. Styles come from the console page. */
(function (root) {
'use strict';
const el = (t, txt, cls) => { const x = document.createElement(t); if (txt != null) x.textContent = String(txt); if (cls) x.className = cls; return x; };
const inp = (type, val, ph) => { const i = el('input'); i.type = type; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; };
const btn = (t, fn, cls = 'b s') => { const b = el('button', t, cls); b.type = 'button'; b.onclick = fn; return b; };
const when = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' }) : '—';
const say = (id, t, err) => { const m = document.getElementById(id); if (!m) return; m.textContent = t || ''; m.className = 'msg' + (err ? ' e' : ''); };
// ---------- assessment results (founder only) ----------
function assessmentView(list, ins, onReset) {
  const d = el('details'); d.open = list.some(a => a.completed_at);
  d.append(el('summary', 'Assessments (' + list.filter(a => a.completed_at).length + ' of ' + list.length + ' completed)'));
  list.forEach(a => {
    const I = ins[a.kind] || { name: a.kind, scales: {}, max: 5 };
    const c = el('div', null, 'rb-sec'); c.append(el('h3', I.name + ' · ' + (a.completed_at ? 'completed ' + when(a.completed_at) : 'in progress, ' + (a.answers || []).filter(x => x != null).length + ' answered, last saved ' + when(a.saved_at))));
    if (a.scores) Object.entries(I.scales).forEach(([k, label]) => {
      const v = a.scores[k], row = el('div'); row.style.cssText = 'display:grid;grid-template-columns:150px 1fr 44px;gap:10px;align-items:center;font-size:13.5px;padding:4px 0';
      const trk = el('div'); trk.style.cssText = 'height:8px;background:#ece7de;position:relative';
      const f = el('div'); f.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${((v - 1) / (I.max - 1) * 100).toFixed(1)}%;background:var(--navy)`;
      const mid = el('div'); mid.style.cssText = 'position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--muted)';
      trk.append(f, mid); row.append(el('span', label), trk, el('b', v.toFixed(2))); c.append(row);
    });
    if (a.scores) { const n = el('p', 'Mean per scale, 1 to ' + I.max + '. The line marks the scale midpoint, not a norm. She sees her own results.'); n.style.cssText = 'font-size:12px;color:var(--muted);margin:6px 0 0'; c.append(n); }
    const past = (a.history || []).filter(h => h.completed_at);
    if (past.length) { const h = el('details'); h.append(el('summary', 'Earlier attempts (' + past.length + ')')); past.forEach(x => h.append(el('div', 'Completed ' + when(x.completed_at) + ' · ' + Object.entries(I.scales).map(([k, l]) => l + ' ' + Number((x.scores || {})[k]).toFixed(2)).join(' · ')))); c.append(h); }
    if (onReset && (a.completed_at || (a.answers || []).some(x => x != null))) c.append(btn('Let her redo this test', async () => {
      if (!confirm('Clear this test so she can take it again? Her current answers and scores are kept under Earlier attempts.')) return;
      try { await onReset(a.kind); } catch (e) { alert(e.message); }
    }, 'b g s'));
    d.append(c);
  });
  return d;
}

// ---------- voice report builder ----------
// Import the EmoWave PDF (read in this browser, never uploaded), mark the journey grid,
// edit the readings, preview exactly what the client will see, then publish.
const LEVELS = ['High', 'Good', 'Low'];
const SLOT = (k, l) => [[k + '.emotion', 'text', l + ' · emotion', 'em'], [k + '.text', 'long', l + ' · reading'], [k + '.deep', 'long', l + ' · deeper read (Read more)'], [k + '.attention', 'long', l + ' · what to pay attention to']];
const SENSE = (k, l) => [[`sensory.${k}.sense`, 'text', l + ' · sense'], [`sensory.${k}.direction`, 'text', l + ' · direction'], [`sensory.${k}.energy`, 'text', l + ' · energy'], [`sensory.${k}.text`, 'long', l + ' · sense reading'], [`sensory.${k}.direction_text`, 'long', l + ' · direction reading'], [`sensory.${k}.energy_text`, 'long', l + ' · energy reading']];
const IMG = () => ['image', 'text', 'In one image (a one-line metaphor shown at the top of the chapter; leave empty to hide)'];
const RS = [
  { k: 'meta', title: 'Reading style', f: [['style', 'select', 'How the report is laid out. Set automatically from the brain scores on import', [['right', 'Right-brain: whole picture first (map, images, shapes)'], ['balanced', 'Balanced'], ['left', 'Left-brain: structure first']]]] },
  { k: 'synthesis', title: 'Overview', f: [['headline', 'text', 'Headline'], ['intro', 'long', 'Intro (optional)'], ['signals', 'list', 'Executive synthesis cards', [['label', 'Signal'], ['value', 'Value'], ['strength', 'Strength']]], ['read', 'long', 'Cross-layer read'], ['changes', 'long', 'What this changes'], ['questions', 'lines', 'Questions we will work on (one per line)']] },
  { k: 'emotional', title: '01 Emotional mastery', f: [IMG(), ...SLOT('thrive', 'Empowering'), ['thrive.also', 'lines', 'Empowering · other emotions (one per line)'], ...SLOT('drain', 'Dis-empowering'), ['drain.also', 'lines', 'Dis-empowering · other emotions (one per line)'], ...SLOT('visible', 'Frequent emotion'), ...SLOT('deep', 'Core emotion'), ['tones', 'list', 'Rhythmic pattern (notes and general reaction)', [['note', 'Note'], ['text', 'How it lands', 'long']]], ['test', 'long', 'Test it this month']] },
  { k: 'mind', title: '02 How your mind works', f: [IMG(), ...SENSE('base', 'Take in (base)'), ...SENSE('next', 'Process (next)'), ['sensory.text', 'long', 'Process summary'], ['brain.left', 'number', 'Left hemisphere'], ['brain.right', 'number', 'Right hemisphere'], ['brain.label', 'text', 'Brain result (e.g. Right-brain led)'], ['brain.text', 'long', 'What this suggests'], ['brain.line', 'text', 'Closing line'], ['brain.helps', 'lines', 'How they take things in best (one per line)'], ['brain.drains', 'lines', 'What wears them down (one per line)'], ['stress.value', 'number', 'Stress value'], ['stress.type', 'text', 'Stress type'], ['stress.text', 'long', 'Stress reading'], ['test', 'long', 'Test it this month']] },
  { k: 'social', title: '03 Social mirror', f: [IMG(), ['archetype.name', 'text', 'Present character'], ['archetype.sub', 'text', 'Traits'], ['archetype.text', 'long', 'Reading'], ['perception_summary', 'long', 'Constructive attributes · intro'], ['perception', 'list', 'Top 5 constructive attributes', [['t', 'Quality'], ['d', 'Note (optional)', 'long']]], ['motivator.name', 'text', 'Real intention'], ['motivator.sub', 'text', 'Traits'], ['motivator.text', 'long', 'Reading'], ['motivator.force', 'long', 'Driving force'], ['leadership', 'list', 'Seven leadership dynamics', [['t', 'Dynamic'], ['sub', 'Subtitle'], ['level', 'Level', LEVELS], ['d', 'Note', 'long']]], ['leadership_summary', 'long', 'Leadership summary'], ['test', 'long', 'Test it this month']] },
  { k: 'negativity', title: '04 Negativity', f: [IMG(), ['core.name', 'text', 'Your own reading (optional; e.g. Fear of betrayal; leave empty to hide)'], ['core.text', 'long', 'Core · reading'], ['core.affects', 'long', 'What this may affect'], ['core.cues', 'list', 'Awareness cues', [['t', 'Cue'], ['d', 'Description', 'long']]], ['patterns', 'list', 'Top 5 restrictive attributes', [['name', 'Short name (for the map)'], ['text', 'EmoWave wording', 'long'], ['summary', 'Your one line (optional)'], ['notice', 'Your notice cue (optional)', 'long']]], ['test', 'long', 'Test it this month']] },
  { k: 'body', title: '05 Mind and body', f: [IMG(), ['patterns', 'list', 'Wellness challenges', [['title', 'Wellness'], ['meaning', 'EmoWave description', 'long'], ['interpretation', 'Your reading (optional)', 'long'], ['asking', 'What it may be asking for (optional)', 'long'], ['closing', 'Closing line (optional)']]], ['organs', 'lines', 'Organ indicators (one per line)'], ['test', 'long', 'Test it this month']] },
  { k: 'journey', title: '06 Life journey', f: [IMG(), ['@grid'], ['markers', 'list', 'Markers', [['label', 'Label'], ['value', 'Value']]], ['insight', 'long', 'Journey insight'], ['meaning', 'long', 'What this may mean'], ['test', 'long', 'Test it this month']] },
  { k: 'notes', title: 'Session notes and recommendations', f: [['session', 'long', 'Session notes (after the session)'], ['tests', 'checks', 'Assessments the client takes in their report', [['six_factor', 'Six-factor personality (HEXACO model)'], ['dark_triad', 'Dark Triad']]], ['recommendations', 'long', 'Recommendations']] },
];
const SUGGEST = { em: Object.keys((window.MaktoubEmowave || { LIB: { EMO: {} } }).LIB.EMO) };
const getP = (o, p) => p.split('.').reduce((a, k) => a == null ? undefined : a[k], o);
const setP = (o, p, v) => { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach(k => { a[k] = a[k] && typeof a[k] === 'object' ? a[k] : {}; a = a[k]; }); a[ks.at(-1)] = v; };
const hasContent = o => JSON.stringify(o || {}).replace(/[{}\[\]":,]|null|journey|levels|ages|age/g, '').length > 20;
let pdfjsReady = null;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return pdfjsReady = pdfjsReady || new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; rej(new Error('Could not load the PDF reader. Check the connection and try again.')); };
    document.head.append(s);
  });
}
function reportBuilder(report, ctx) {
  const E = window.MaktoubEmowave;
  const wrap = el('details'); wrap.open = !!ctx.open;
  wrap.append(el('summary', 'Voice report · ' + (report ? report.status + (report.published_at ? ' ' + when(report.published_at) : '') : 'not started')));
  const note = el('p', '1 Import the voice analysis PDF. 2 Tick the life-journey grid from page 5. 3 Read every chapter and make it yours. 4 Preview, then publish. Nothing is visible to the client until you publish; saving a draft locks the recording.');
  note.style.cssText = 'font-size:13px;color:var(--muted)'; wrap.append(note);
  const dls = el('div'); Object.entries(SUGGEST).forEach(([k, opts]) => { const d = el('datalist'); d.id = 'dl_' + k; opts.forEach(o => { const op = el('option'); op.value = o; d.append(op); }); dls.append(d); }); wrap.append(dls);
  let model = JSON.parse(JSON.stringify(report?.data || {})), pdfName = '';
  if (!model.journey) model.journey = {};

  // 1. Import
  const imp = el('div', null, 'rb-sec'); imp.append(el('h3', 'Import voice analysis PDF'));
  const file = inp('file'); file.accept = 'application/pdf,.pdf';
  const impMsg = el('p', '', 'msg');
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    if (hasContent(model) && !confirm('Replace the current draft with this import? Session notes and the journey grid are kept.')) { file.value = ''; return; }
    impMsg.className = 'msg'; impMsg.textContent = 'Reading ' + f.name + '…';
    try {
      const lib = await loadPdfjs();
      const raw = await E.extract(lib, new Uint8Array(await f.arrayBuffer()));
      const keepNotes = model.notes, j = model.journey || {};
      model = E.compose(raw, { fileName: f.name, age: j.age, levels: j.levels });
      if (keepNotes) model.notes = { ...model.notes, ...keepNotes };
      const got = [raw.stress && 'stress ' + raw.stress.value, raw.brain && 'brain ' + raw.brain.left + '/' + raw.brain.right, raw.present && raw.present.name, (raw.leadership || []).length + ' dynamics', (raw.restrictive || []).length + ' restrictive', (raw.wellness || []).length + ' wellness'].filter(Boolean);
      pdfName = raw.name || '';
      impMsg.textContent = 'Imported ' + f.name + (raw.name ? ' (name on the PDF: ' + raw.name + ')' : '') + (raw.date ? ', dated ' + raw.date : '') + ': ' + got.join(', ') + '. ' + raw.warnings.join(' ') + ' The client sees only their own name, never the name on the PDF.';
      build();
    } catch (e) { impMsg.className = 'msg e'; impMsg.textContent = 'Could not read this PDF: ' + e.message; }
    file.value = '';
  };
  imp.append(file, impMsg); wrap.append(imp);

  const lintBox = el('div'), form = el('div');
  const runLint = () => {
    lintBox.replaceChildren(); const hits = E ? E.lint(model) : [];
    const own = String(ctx.clientName || '').toLowerCase(), foreign = String(pdfName).split(/\s+/).filter(w => w.length > 2 && !own.includes(w.toLowerCase()));
    if (foreign.length) { const re = new RegExp('\\b(' + foreign.join('|') + ')\\b', 'i'); const walk = (v, p) => typeof v === 'string' ? (re.test(v) && hits.push({ path: p, words: ['name from the PDF'], text: v })) : v && typeof v === 'object' && Object.entries(v).forEach(([k, x]) => walk(x, p ? p + '.' + k : k)); walk(model, ''); }
    if (hits.length) { const a = el('div', null, 'alert'); a.append(el('b', 'Review before publishing: ' + hits.length + ' passage' + (hits.length > 1 ? 's' : '') + ' read as clinical or third-person.')); hits.forEach(h => a.append(el('div', h.path + ' · ' + h.words.join(', ')))); lintBox.append(a); }
    return hits;
  };

  // Journey grid (EmoWave page 5): twelve periods, levels 1–7.
  const journeyGrid = () => {
    const j = model.journey = model.journey || {};
    const box = el('div');
    const age = inp('number', j.age ?? '', 'Age'); age.style.maxWidth = '120px';
    const ages = inp('text', (j.ages || []).join(', '), 'Ages, oldest first');
    age.oninput = () => { j.age = age.value === '' ? '' : +age.value; j.ages = E.journeyAges(j.age); ages.value = j.ages.join(', '); paint(); };
    ages.onchange = () => { j.ages = ages.value.split(/[,\s]+/).map(Number).filter(n => n > 0); paint(); };
    const grid = el('div'); grid.style.cssText = 'display:grid;gap:3px;margin-top:8px;overflow-x:auto';
    const colr = l => l >= 6 ? '#9b2c2c' : l >= 4 ? '#a8741a' : '#2f6b4f';
    const paint = () => {
      const a = j.ages || []; j.levels = (j.levels || []).slice(0, a.length);
      grid.style.gridTemplateColumns = '28px repeat(' + Math.max(a.length, 1) + ', minmax(26px,1fr))'; grid.replaceChildren();
      for (let l = 7; l >= 1; l--) {
        grid.append(el('span', l, '')); grid.lastChild.style.cssText = 'font-size:11px;color:var(--muted);align-self:center';
        a.forEach((_, i) => { const b = el('button', ''); b.type = 'button'; const on = +j.levels[i] === l;
          b.style.cssText = `height:24px;border:1.5px solid ${colr(l)};border-radius:50%;background:${on ? colr(l) : '#fff'};cursor:pointer;padding:0;width:24px;justify-self:center`;
          b.title = 'Age ' + a[i] + ' · level ' + l; b.onclick = () => { j.levels[i] = on ? null : l; paint(); runLint(); }; grid.append(b); });
      }
      grid.append(el('span', '')); a.forEach(x => { const s = el('span', x); s.style.cssText = 'font-size:11px;text-align:center;color:var(--muted)'; grid.append(s); });
    };
    paint();
    const write = btn('Write journey reading from the grid', () => {
      const jr = E.journeyRead(j.ages || [], j.levels || []);
      if (!jr) return say('rbMsg', 'Tick at least four periods first.', true);
      if ((j.insight || j.meaning) && !confirm('Replace the journey markers, insight and meaning?')) return;
      Object.assign(j, { markers: jr.markers, insight: jr.insight, meaning: jr.meaning }); build();
    }, 'b g s');
    const hint = el('p', 'From page 5: enter the age written in the box, then tick the circle for each period, childhood on the left. Green 1–3 constructive, orange 4–5 mixed, red 6–7 restrictive.'); hint.style.cssText = 'font-size:12.5px;color:var(--muted);margin:4px 0';
    box.append(el('label', 'Life journey grid'), hint, el('label', 'Age'), age, el('label', 'Period ages (childhood → now)'), ages, grid, write);
    return box;
  };

  const field = (full, type, label, extra) => {
    const out = [el('label', label)];
    if (type === 'list') {
      const rows = getP(model, full) || [], list = el('div');
      rows.forEach((row, i) => {
        const stacked = extra.some(x => x[2] === 'long'), rr = el('div', null, stacked ? 'rb-card' : 'rb-row');
        extra.forEach(([k, l, opt]) => {
          let x;
          if (Array.isArray(opt)) { x = el('select'); opt.forEach(o => { const op = el('option', o); op.selected = row[k] === o; x.append(op); }); }
          else if (opt === 'long') { x = el('textarea'); x.value = row[k] ?? ''; x.placeholder = l; x.style.minHeight = '54px'; }
          else { x = inp(opt === 'num' ? 'number' : 'text', row[k] ?? '', l); if (opt && SUGGEST[opt]) x.setAttribute('list', 'dl_' + opt); }
          x.oninput = x.onchange = () => { row[k] = opt === 'num' ? (x.value === '' ? '' : +x.value) : x.value; runLint(); };
          if (stacked) { const lb = el('span', l); lb.style.cssText = 'font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);display:block;margin-top:6px'; rr.append(lb); }
          rr.append(x);
        });
        const bar = el('div'); bar.style.cssText = 'display:flex;gap:4px;justify-content:flex-end';
        if (i > 0) bar.append(btn('↑', () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); build(); }, 'b g s'));
        bar.append(btn('×', () => { rows.splice(i, 1); build(); }, 'b g s')); rr.append(bar);
        list.append(rr);
      });
      out.push(list, btn('+ Add', () => { const arr = getP(model, full) || []; arr.push({}); setP(model, full, arr); build(); }, 'b g s'));
      return out;
    }
    let x;
    if (type === 'checks') {
      const box = el('div'); const cur = () => getP(model, full) || [];
      extra.forEach(([v, l]) => { const row = el('label'); row.style.cssText = 'display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink);font-weight:400';
        const c = inp('checkbox'); c.style.width = 'auto'; c.checked = cur().includes(v); c.onchange = () => setP(model, full, c.checked ? [...new Set([...cur(), v])] : cur().filter(x => x !== v)); row.append(c, document.createTextNode(l)); box.append(row); });
      out.push(box); return out;
    }
    if (type === 'select') {
      x = el('select'); [['', 'Automatic'], ...extra].forEach(([v, l]) => { const o = el('option', l); o.value = v; o.selected = (getP(model, full) || '') === v; x.append(o); });
      x.onchange = () => setP(model, full, x.value); out.push(x); return out;
    }
    if (type === 'long' || type === 'lines') { x = el('textarea'); x.value = type === 'lines' ? (getP(model, full) || []).join('\n') : (getP(model, full) ?? ''); }
    else { x = inp(type === 'number' ? 'number' : 'text', getP(model, full) ?? ''); if (type === 'number') x.step = 'any'; if (extra && SUGGEST[extra]) x.setAttribute('list', 'dl_' + extra); }
    x.oninput = () => { setP(model, full, type === 'lines' ? x.value.split('\n').map(t => t.trim()).filter(Boolean) : type === 'number' ? (x.value === '' ? '' : +x.value) : x.value); runLint(); };
    out.push(x); return out;
  };
  const openSecs = new Set();
  const build = () => {
    form.replaceChildren();
    if (model.meta && model.meta.date) { const m = el('p', 'Analysis dated ' + model.meta.date); m.style.cssText = 'font-size:13px;margin:10px 0 0'; form.append(m); }
    for (const sec of RS) {
      const s = el('details', null, 'rb-sec'); s.open = openSecs.has(sec.k); s.ontoggle = () => s.open ? openSecs.add(sec.k) : openSecs.delete(sec.k);
      s.append(el('summary', sec.title));
      for (const [path, type, label, extra] of sec.f) path === '@grid' ? s.append(journeyGrid()) : s.append(...field(sec.k + '.' + path, type, label, extra));
      form.append(s);
    }
    runLint();
  };
  build(); wrap.append(lintBox, form);

  const io = el('details'); io.append(el('summary', 'Import / export JSON'));
  const ta = el('textarea'); ta.style.minHeight = '160px'; ta.placeholder = 'Paste report JSON, then Import.';
  io.append(ta, btn('Export current', () => { ta.value = JSON.stringify(model, null, 2); }, 'b g s'), btn('Import', () => { try { model = JSON.parse(ta.value); build(); say('rbMsg', 'Imported. Review, then save.'); } catch (_) { say('rbMsg', 'That is not valid JSON.', true); } }, 'b g s'));
  wrap.append(io);
  const clean = o => JSON.parse(JSON.stringify(o, (k, v) => (v === '' || v === null || (Array.isArray(v) && !v.length)) ? undefined : v));
  const save = async (extra, msg) => { try { await ctx.save({ data: clean(model), ...extra }); say('rbMsg', msg); if (ctx.after) await ctx.after(); } catch (e) { say('rbMsg', e.message, true); } };
  const preview = () => {
    try { localStorage.setItem('maktoub_report_preview', JSON.stringify({ data: clean(model), at: new Date().toISOString(), name: String(ctx.clientName || '').split(/\s+/)[0], reference: ctx.reference || '' })); }
    catch (_) { return say('rbMsg', 'This browser blocked the preview.', true); }
    window.open('/ready/report/?preview', 'maktoub_preview');
  };
  wrap.append(btn('Preview as client', preview, 'b g'), btn('Save draft', () => save({}, 'Draft saved.')),
    btn('Publish to client portal', () => { const n = runLint().length; if (confirm((n ? n + ' passage(s) are flagged for review. ' : '') + 'Publish the report? The client sees it in their portal immediately.')) save({ publish: true }, 'Published. The client can open it from their portal.'); }, 'b s'));
  if (report?.status === 'published') wrap.append(btn('Unpublish', () => save({ unpublish: true }, 'Unpublished.'), 'b g s'));
  const m = el('p', '', 'msg'); m.id = 'rbMsg'; wrap.append(m);
  return wrap;
}


root.MaktoubReportBuilder = { reportBuilder, assessmentView };
})(window);
