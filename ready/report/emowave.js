/* Maktoub · EmoWave import and reading library.
   Used by the founder console only. It turns an EmoWave "Full" PDF into the
   voice report data the client report renders, with Maktoub's default readings
   filled in. Everything it produces is a draft for the founder to edit.
   Nothing here is sent anywhere: the PDF is read in the browser. */
(function (root) {
'use strict';

// ---------- small helpers ----------
const clean = s => String(s || '').replace(/\s+/g, ' ').replace(/\s+([.,;:?!])/g, '$1').replace(/\.{2,}$/, '.').trim();
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const title = s => clean(s).toLowerCase().replace(/(^|[\s/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
// EmoWave writes in the third person ("his/her"); the report speaks to the client.
const second = s => clean(s)
  .replace(/\bhis\/her\b/gi, 'your').replace(/\bher\/his\b/gi, 'your')
  .replace(/\bhim\/her\b/gi, 'you').replace(/\bhe\/she\b/gi, 'you').replace(/\bshe\/he\b/gi, 'you')
  .replace(/\bhimself\/herself\b/gi, 'yourself').replace(/\bone's\b/gi, 'your');
const sentence = s => { s = cap(second(s)); return s && !/[.?!]$/.test(s) ? s + '.' : s; };
const traitList = t => joinList(clean(t).toLowerCase().split(/\s*,\s*/).filter(Boolean));
const joinList = a => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a.at(-1);

// ---------- PDF text, column-aware ----------
// Returns pages of segments {x, x2, y, h, s}; items on one baseline that touch are merged.
async function readPdf(pdfjsLib, data) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const raw = items.filter(i => i.str && i.str.trim()).map(i => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]), s: i.str }));
    raw.sort((a, b) => (Math.abs(a.y - b.y) < 1.5 ? a.x - b.x : b.y - a.y));
    const segs = [];
    for (const it of raw) {
      const last = segs[segs.length - 1];
      if (last && Math.abs(last.y - it.y) < 1.5 && it.x - last.x2 < 4) {
        last.s += (it.x - last.x2 > 0.8 && !/\s$/.test(last.s) && !/^\s/.test(it.s) ? ' ' : '') + it.s;
        last.x2 = Math.max(last.x2, it.x + it.w);
      } else segs.push({ x: it.x, x2: it.x + it.w, y: it.y, h: it.h, s: it.s });
    }
    segs.forEach(s => { s.s = s.s.replace(/\s+/g, ' ').trim(); });
    pages.push({ width: page.view[2], segs });
  }
  return pages;
}

const find = (segs, re) => segs.find(s => re.test(s.s));
const below = (segs, y, until) => segs.filter(s => s.y < y - 0.5 && (until == null || s.y > until + 0.5));
const textOf = list => clean(list.slice().sort((a, b) => b.y - a.y || a.x - b.x).map(s => s.s).join(' '));
// Group a column's lines into blocks separated by vertical gaps.
function blocks(list, gap) {
  const out = []; let cur = null;
  list.slice().sort((a, b) => b.y - a.y).forEach(s => { if (!cur || cur.at(-1).y - s.y > gap) out.push(cur = []); cur.push(s); });
  return out;
}

function parse(pages) {
  const all = pages.map(p => p.segs);
  const raw = { source: 'EmoWave', warnings: [] };
  const warn = m => raw.warnings.push(m);
  const pageWith = re => { const i = all.findIndex(segs => segs.some(s => re.test(s.s))); return i < 0 ? null : { segs: all[i], mid: pages[i].width / 2 }; };

  // Name and date (first page header)
  const p1 = pageWith(/Name:/);
  if (p1) {
    const n = find(p1.segs, /^Name:/), d = find(p1.segs, /^Date:/);
    raw.name = clean(p1.segs.filter(s => Math.abs(s.y - n.y) < 1.5 && s.x >= n.x && (!d || s.x < d.x)).map(s => s.s).join(' ').replace(/^Name:\s*/, ''));
    if (d) raw.date = clean(p1.segs.filter(s => Math.abs(s.y - d.y) < 1.5 && s.x >= d.x).map(s => s.s).join('').replace(/^Date:\s*/, ''));
  }
  const ref = all.flat().map(s => s.s).join(' ').match(/\bEW[- ]?\d{3,6}\b/);
  if (ref) raw.ref = ref[0].replace(' ', '-');

  // 1. Stress level
  const sp = pageWith(/Your Stress Level/);
  if (sp) {
    const h = find(sp.segs, /Your Stress Level/), next = find(sp.segs, /Your Emotional State/);
    const zone = below(sp.segs, h.y, next && next.y);
    const num = zone.find(s => /^\d{1,3}(\.\d+)?$/.test(s.s));
    if (num) raw.stress = { value: +num.s };
    const desc = zone.filter(s => s !== num && s.h < (num ? num.h * 0.75 : 7) && s.x < sp.mid + 40 && !/^\d/.test(s.s) && !/%|^(Logical|Stable|Accumulated|Emotional|Extreme)\b|^Stress$|\(emotions\)/.test(s.s));
    if (raw.stress) raw.stress.text = textOf(desc);
  } else warn('Stress level not found.');

  // 2. Emotional state
  const ep = pageWith(/^Empowering$/);
  if (ep) {
    const e = find(ep.segs, /^Empowering$/), n1 = find(ep.segs, /^Note 1$/);
    const zone = below(ep.segs, e.y, n1 && n1.y).filter(s => /^[A-Z][A-Z' -]+$/.test(s.s));
    raw.empowering = zone.filter(s => s.x < ep.mid).sort((a, b) => b.y - a.y).map(s => title(s.s));
    raw.disempowering = zone.filter(s => s.x >= ep.mid).sort((a, b) => b.y - a.y).map(s => title(s.s));
    const notes = ep.segs.filter(s => /^Note \d$/.test(s.s)).sort((a, b) => b.y - a.y);
    const rp = find(ep.segs, /^Rhythmic Pattern/);
    raw.notes = notes.map((n, i) => {
      const lo = i + 1 < notes.length ? notes[i + 1].y : (rp ? rp.y : 0);
      const z = below(ep.segs, n.y + 2, lo);
      const letter = z.find(s => s.x < ep.mid && /^[A-G]#?$/.test(s.s));
      const react = z.filter(s => s.x > ep.mid - 30 && !/General Reaction/.test(s.s));
      return { note: letter ? letter.s : '', reaction: textOf(react) };
    });
    const fe = find(ep.segs, /^Frequent Emotion/), ce = find(ep.segs, /^Core Emotion/);
    if (fe) {
      const z = below(ep.segs, fe.y - 1).filter(s => s.x < (ce ? ce.x - 5 : ep.mid) && s.y > fe.y - 60);
      const bl = blocks(z, 9);
      raw.frequent = { short: bl[0] ? textOf(bl[0]) : '', text: bl[1] ? textOf(bl[1]) : '' };
    }
    if (ce) {
      const z = below(ep.segs, ce.y - 1).filter(s => s.x >= ce.x - 5 && s.y > ce.y - 60);
      const bl = blocks(z, 9);
      raw.core = { short: bl[0] ? textOf(bl[0]) : '', text: bl[1] ? textOf(bl[1]) : '' };
    }
  } else warn('Emotional state not found.');

  // 3. Sensory attributes
  const sn = pageWith(/^BASE$/);
  if (sn) {
    const b = find(sn.segs, /^BASE$/), br = find(sn.segs, /Brain Activit/);
    const z = below(sn.segs, b.y - 6, br && br.y).filter(s => /^[A-Za-z]+$/.test(s.s));
    const col = left => z.filter(s => left ? s.x < sn.mid : s.x >= sn.mid).sort((a, c) => c.y - a.y).map(s => s.s);
    const pick = arr => ({ sense: title(arr[0] || ''), direction: title((arr[1] || '').replace(/^Intward$/i, 'Inward')), energy: title(arr[2] || '') });
    raw.sensory = { base: pick(col(true)), next: pick(col(false)) };
  } else warn('Sensory attributes not found.');

  // 4. Brain
  const bp = pageWith(/^Left$/);
  if (bp) {
    const l = find(bp.segs, /^Left$/), r = find(bp.segs, /^Right$/);
    const numUnder = h => bp.segs.filter(s => /^\d+$/.test(s.s) && s.y < h.y && s.y > h.y - 25 && Math.abs(s.x - h.x) < 30)[0];
    const ln = numUnder(l), rn = r && numUnder(r);
    raw.brain = { left: ln ? +ln.s : null, right: rn ? +rn.s : null };
  } else warn('Brain activity not found.');

  // 5. Present character and real intention
  const cp = pageWith(/^Present Character$/);
  if (cp) {
    const heads = cp.segs.filter(s => /^Character$/.test(s.s)).sort((a, b) => b.y - a.y);
    const traitsX = cp.segs.filter(s => /^(Present Character|Real Intention)$/.test(s.s) && s.x > 50).map(s => s.x);
    const sumX = cp.segs.filter(s => /^Summary$/.test(s.s)).map(s => s.x);
    const tx = traitsX.length ? Math.min(...traitsX) - 8 : 70, sx = sumX.length ? Math.min(...sumX) - 8 : 170;
    const lead = find(cp.segs, /Leadership Dynamics/);
    const row = (h, lo) => {
      const z = below(cp.segs, h.y, lo).filter(s => !/^(Real Intention|Present Character)$/.test(s.s));
      return { name: textOf(z.filter(s => s.x < tx)), traits: textOf(z.filter(s => s.x >= tx && s.x < sx)), summary: textOf(z.filter(s => s.x >= sx)) };
    };
    if (heads[0]) raw.present = row(heads[0], heads[1] ? heads[1].y + 14 : (lead && lead.y));
    if (heads[1]) raw.intention = row(heads[1], lead && lead.y);
  } else warn('Present character not found.');

  // 6. Seven leadership dynamics
  const lp = pageWith(/^\d\s*-\s*Purpose/);
  if (lp) {
    raw.leadership = lp.segs.filter(s => /^\d\s*-\s*[^:]+:/.test(s.s)).map(h => {
      const m = h.s.match(/^(\d)\s*-\s*([^:]+?)\s*:\s*(.+)$/);
      const lv = lp.segs.find(s => s.y < h.y && s.y > h.y - 20 && s.x > h.x && s.x < h.x + 190 && /^(High|Good|Medium|Moderate|Low)$/i.test(s.s));
      return { n: +m[1], t: m[2].trim().replace(/^Self (\w)/, (x, c) => 'Self-' + c.toLowerCase()), sub: clean(m[3]), level: lv ? cap(lv.s.toLowerCase()) : '' };
    }).sort((a, b) => a.n - b.n);
  } else warn('Leadership dynamics not found.');

  // 7. Constructive / restrictive
  const ap = pageWith(/^Constructive$/);
  if (ap) {
    const c = find(ap.segs, /^Constructive$/), r = find(ap.segs, /^Restrictive$/);
    const nums = ap.segs.filter(s => /^[1-9]$/.test(s.s) && s.x < c.x && s.y < c.y && s.y > c.y - 120).sort((a, b) => b.y - a.y);
    const rx = r ? r.x - 6 : ap.mid;
    const restr = ap.segs.filter(s => s.x >= rx && s.y < (r ? r.y : c.y) - 1 && s.y > c.y - 120 && !/^Restrictive$/.test(s.s));
    raw.constructive = []; raw.restrictive = [];
    nums.forEach((n, i) => {
      const top = n.y + 7, bot = nums[i + 1] ? nums[i + 1].y + 7 : n.y - 20;
      raw.constructive.push(textOf(ap.segs.filter(s => s.x > n.x + 5 && s.x < rx && Math.abs(s.y - n.y) < 1.5)));
      raw.restrictive.push(textOf(restr.filter(s => s.y <= top && s.y > bot)));
    });
  } else warn('Constructive and restrictive attributes not found.');

  // 8. Wellness challenges (may run across pages)
  raw.wellness = []; raw.organs = [];
  all.forEach((segs, pi) => {
    const hd = segs.find(s => s.s === 'Wellness'); if (!hd) return;
    const desc = segs.find(s => s.s === 'Description' && Math.abs(s.y - hd.y) < 2);
    const hash = segs.find(s => s.s === '#' && Math.abs(s.y - hd.y) < 2);
    const dx = desc ? desc.x - 6 : hd.x + 70;
    const org = segs.find(s => /^Organs$/.test(s.s));
    const maxX = org ? org.x - 6 : pages[pi].width * 0.75;
    const stop = segs.find(s => /^DISCLAIMER/.test(s.s));
    const zone = segs.filter(s => s.y < hd.y - 1 && (!stop || s.y > stop.y));
    const nums = zone.filter(s => /^\d$/.test(s.s) && hash && Math.abs(s.x - hash.x) < 6).sort((a, b) => b.y - a.y);
    const nameB = blocks(zone.filter(s => s.x > (hash ? hash.x + 6 : 0) && s.x < dx && !/^\d$/.test(s.s)), 12);
    const descB = blocks(zone.filter(s => s.x >= dx && s.x < maxX), 11);
    const near = b => { const cy = (b[0].y + b.at(-1).y) / 2; let best = null, d = 1e9; nums.forEach(n => { const k = Math.abs(n.y - cy); if (k < d) { d = k; best = n; } }); return best; };
    nums.forEach(n => {
      raw.wellness.push({ n: +n.s, title: textOf(nameB.filter(b => near(b) === n).flat()), description: textOf(descB.filter(b => near(b) === n).flat()) });
    });
    if (org) raw.organs.push(...segs.filter(s => s.x > org.x + 20 && s.y < org.y + 20 && s.y > org.y - 40).sort((a, b) => b.y - a.y).map(s => clean(s.s)));
  });
  raw.wellness.sort((a, b) => a.n - b.n);
  if (!raw.wellness.length) warn('Wellness challenges not found.');
  warn('Life journey ticks and ages are drawn on the page, not stored as text. Enter them in the journey grid.');
  return raw;
}

async function extract(pdfjsLib, data) { return parse(await readPdf(pdfjsLib, data)); }

// ---------- reading library (Maktoub voice: patterns to test, not verdicts) ----------
const STRESS_BANDS = [{ k: 'Logical', from: 0, to: 5 }, { k: 'Stable', from: 6, to: 11 }, { k: 'Accumulated', from: 12, to: 20 }, { k: 'Emotional', from: 20, to: 54 }, { k: 'Extreme', from: 54, to: 80 }];

const SENSES = {
  Feeling: { base: 'You take the world in through the body first: atmosphere, tone and how something feels before what it looks like or what was said.', next: 'You make sense of things by checking how they sit with you. A decision is not finished until it feels right.' },
  Hearing: { base: 'You take the world in through words and tone first. What was said, and how it was said, lands before anything else.', next: 'You make sense of things by talking them through, out loud or inside your own head. Inner dialogue is where you sort.' },
  Seeing: { base: 'You take the world in visually first: pictures, layout and what is in front of you.', next: 'You make sense of things by seeing them laid out. When you can picture it, you can decide.' },
  Thinking: { base: 'You take the world in as ideas first, looking for the logic underneath.', next: 'You make sense of things by analysing them until the structure is clear.' },
};
const DIRECTION = { Outward: 'Your attention moves out toward people and the environment; you read the room before yourself.', Inward: 'Your attention turns inward; you check your own reaction before you respond.' };
const ENERGY = { Extrovert: 'Energy comes from engagement: people, movement and conversation recharge you.', Introvert: 'Energy comes from quiet: you integrate best with space and time alone.' };

const BRAIN = {
  right: { label: 'Right-brain led', text: 'Your right hemisphere appears to lead. You absorb broadly, read pattern, tone and meaning, and synthesise before you can break things into steps.', line: 'You may understand the whole before you can explain the steps.' },
  left: { label: 'Left-brain led', text: 'Your left hemisphere appears to lead. You work through structure, sequence and logic, and feel steadier when the steps are clear.', line: 'You may need the steps before you trust the whole.' },
  balanced: { label: 'Balanced', text: 'Neither hemisphere clearly dominates. You can move between detail and the big picture, which is useful as long as you choose which one the moment needs.', line: 'Your range is a strength when you choose the mode on purpose.' },
  right_strong: { label: 'Strongly right-brain led', text: 'Your right hemisphere is doing most of the work, by a wide margin. You take in the whole field at once: tone, atmosphere, meaning, and what is not being said. You usually know where something is going long before you could explain why. Your left side, which turns that knowing into steps, sequence and words for other people, is the quieter partner. That gap is not a weakness. It is the shape of how you work, and much of the friction in this report sits exactly there.', line: 'You know before you can explain. The work is building the bridge, not doubting the knowing.' },
  left_strong: { label: 'Strongly left-brain led', text: 'Your left hemisphere is doing most of the work, by a wide margin. You trust what you can sequence, measure and explain, and you are at your best with a clear structure. The right side, which reads atmosphere, feeling and the whole picture, is the quieter partner, so emotional signals may reach you late.', line: 'You trust the steps. The work is letting the felt sense count as data too.' },
};
// How each mind takes things in best, and what drains it.
const BRAIN_WAYS = {
  right: { helps: ['The picture or the feeling first, the steps after', 'The why before the how', 'Images, examples, stories and metaphors', 'Talking it through out loud, or voice notes', 'Seeing the whole map before the first step'], drains: ['Long lists of steps with no picture of where they lead', 'Being asked to justify a knowing before you have felt it through', 'Forms, spreadsheets and detail work with no meaning attached', 'Being rushed from sensing to deciding'] },
  left: { helps: ['A clear plan with numbered steps', 'The facts and the evidence first', 'Time to analyse before deciding', 'Written summaries and checklists'], drains: ['Vague goals with no structure', 'Being asked to decide on feeling alone', 'Constant change of plan', 'Emotion-heavy conversations with no clear point'] },
};
function adapt(out, ctx) {
  const { lead, strong, ratio } = ctx;
  const style = lead === 'right' ? 'right' : lead === 'left' ? 'left' : 'balanced';
  out.meta.style = style;
  if (out.mind.brain && lead && lead !== 'balanced') Object.assign(out.mind.brain, BRAIN_WAYS[lead], { ratio: Math.round(ratio * 10) / 10 });
  if (style !== 'right') return;
  out.synthesis.intro = 'Your right brain leads' + (strong ? ' strongly' : '') + ', so this report starts with the whole picture. The detail is one tap deeper, when you want it.';
  // Links between two EmoWave findings, only where both are present.
  const sd = out.social.leadership.find(x => x.t === 'Self-development' && x.level === 'Low');
  if (strong && sd) sd.d += ' This sits with your brain pattern: understanding arrives whole, and turning it into steps and words for others is the slower half.';
}


const LEAD = {
  Purpose: { High: 'You are strongly connected to your values and an inner sense of direction.', Good: 'Your sense of direction is present and growing clearer.', Low: 'Your sense of direction may feel borrowed or unclear right now.' },
  'Self-awareness': { High: 'You reflect well and can turn insight into beliefs you live by.', Good: 'You notice your patterns, though not always in the moment.', Low: 'You may act on beliefs you have not yet examined.' },
  'Self-development': { High: 'You turn what you learn into clear communication.', Good: 'You have a healthy drive to learn, grow and share what you know.', Low: 'What you know may not yet be reaching the people around you; expression can lag behind understanding.' },
  'Self-management': { High: 'You manage yourself well in relationships and stay steady with people.', Good: 'You manage relationships reasonably well, with some strain under pressure.', Low: 'Relationships and emotional regulation may need more conscious support at the moment.' },
  'Self-belief': { High: 'Your willpower converts reliably into results.', Good: 'Your confidence is mostly steady, with dips under pressure.', Low: 'Confidence in your own power to create results may not feel stable right now.' },
  'Self-esteem': { High: 'You feel you belong, and you allow yourself pleasure.', Good: 'You have a reasonable sense of worth and belonging.', Low: 'Belonging and permission to enjoy may feel conditional, earned rather than given.' },
  Being: { High: 'Your foundation is grounded: experience has become stability.', Good: 'Your foundation is reasonably stable.', Low: 'Your foundation may feel unsettled, as if experience has not yet become ground to stand on.' },
};
const levelOf = l => /high/i.test(l) ? 'High' : /low/i.test(l) ? 'Low' : 'Good';

const EMO_WORDS = [[/sad|tear|grie|melanchol/i, 'Sadness'], [/strong.?will/i, 'Strong will'], [/anger|angry|irrit|rage/i, 'Anger'], [/fear|afraid|scared/i, 'Fear'], [/anxi|worr|nervous/i, 'Worry'], [/determin/i, 'Determination'], [/joy|happy|cheer/i, 'Joy'], [/calm|peace/i, 'Calm'], [/love|affection/i, 'Love'], [/confiden/i, 'Confidence'], [/frustrat/i, 'Frustration'], [/guilt/i, 'Guilt'], [/shame/i, 'Shame'], [/passion/i, 'Passion'], [/trust/i, 'Trust']];
const emoFrom = t => { for (const [re, n] of EMO_WORDS) if (re.test(t || '')) return n; return ''; };

const RESTRICT = [
  [/self.?focus/i, 'More self-focused'], [/role.*relationship|relationship.*role/i, 'Unsure of role in relationships'], [/physical body/i, 'Watching body changes'],
  [/too direct/i, 'Too direct'], [/childlike/i, 'A little childlike'], [/perfect/i, 'Perfectionist'], [/critic/i, 'Self-critical'], [/control/i, 'Need for control'], [/prove/i, 'Proving'],
];
// Speculative clinical wording is not passed through to the client.
const scrub = s => {
  s = String(s || '').replace(/[.,]?\s*(maybe|possibly|perhaps)\s+due to\s+[^.?!]*[.?!]?/gi, '.');
  s = s.split(/(?<=[.?!])\s+/).map(sent => sent.split(/,\s*/).filter(part => !CLINICAL_WORD.test(part)).join(', ')).filter(x => x && !/^[.?!,\s]*$/.test(x)).join(' ');
  return clean(s.replace(/,\s*([.?!])/g, '$1')).replace(/\.\.$/, '.');
};
const CLINICAL_WORD = /\b(autism|austism|autistic|adhd|dyslexi\w*|bipolar|depression|disorder|diagnos\w*|allerg\w*|disease|cancer|tumou?r|syndrome)\b/i;


// ---------- journey ----------
// EmoWave's grid: twelve periods, childhood on the right, now on the left.
// We store them oldest first. Levels 1–3 constructive, 4–5 mixed, 6–7 restrictive.
function journeyAges(age) {
  age = +age; if (!(age > 4)) return [];
  const half = age / 2, first = [], second = [];
  for (let k = 0; k < 6; k++) first.push(Math.max(1, Math.round(half * (1 / 5 + k * 2 / 15))));
  for (let i = 0; i < 6; i++) second.push(Math.round(half + i * (age - half) / 5));
  return first.concat(second);
}
const zone = l => l >= 6 ? 'restrictive' : l >= 4 ? 'mixed' : 'constructive';
function journeyRead(ages, levels) {
  // EmoWave's legend: green = enjoying, fulfilment, gaining energy; red = most challenging period, obstacles.
  // Adjacent reds = a fighter who never gives up. Red changing to green in the next period = may have given up,
  // gone along with the flow, or lost determination. The graph shows that something registered, not what happened.
  const pts = ages.map((a, i) => ({ a, l: +levels[i] })).filter(p => p.l >= 1 && p.l <= 7);
  if (pts.length < 4) return null;
  const col = l => l >= 6 ? 'red' : l >= 4 ? 'orange' : 'green';
  const span = arr => arr[0].a === arr.at(-1).a ? 'age ' + arr[0].a : 'age ' + arr[0].a + '–' + arr.at(-1).a;
  const runs = c => { const out = []; let cur = []; pts.forEach(p => { if (col(p.l) === c) cur.push(p); else { if (cur.length) out.push(cur); cur = []; } }); if (cur.length) out.push(cur); return out; };
  const reds = runs('red'), greens = runs('green').sort((x, y) => y.length - x.length);
  const longGreen = greens[0] && greens[0].length >= 2 ? greens[0].slice().sort((x, y) => x.a - y.a) : null;
  const redToGreen = pts.slice(0, -1).map((p, i) => col(p.l) === 'red' && col(pts[i + 1].l) === 'green' ? pts[i + 1] : null).filter(Boolean);
  const changes = pts.slice(1).filter((p, i) => col(p.l) !== col(pts[i].l));
  const now = pts.at(-1), nowCol = col(now.l);
  let since = now; for (let i = pts.length - 1; i >= 0 && col(pts[i].l) === nowCol; i--) since = pts[i];
  const parts = [];
  if (reds.length) {
    parts.push(`Your most challenging ${reds.length > 1 ? 'periods register' : 'period registers'} at ${joinList(reds.map(span))}, in red.`);
    if (reds.some(r => r.length > 1)) parts.push('The red ticks sit next to each other, which EmoWave reads as a fighter who does not give up.');
  }
  redToGreen.forEach(p => parts.push(`At age ${p.a} the tick moves straight from red to green. EmoWave reads that change as either letting go and going along with the flow, or losing some determination.`));
  if (longGreen) parts.push(`From age ${longGreen[0].a} to ${longGreen.at(-1).a} the ticks stay green: a long period of enjoying what you were doing and gaining energy.`);
  if (since !== pts[0]) parts.push(nowCol === 'green' ? `Since age ${since.a} you have been in green.` : `From age ${since.a} the ticks move into ${nowCol}, and you are in ${nowCol} now.`);
  const turning = changes.map(p => p.a);
  const meaning = 'The graph does not show what happened in your life, only that something happened that had an impact and registered in your subconscious.' + (turning.length ? ` The ${turning.length > 1 ? 'ages' : 'age'} worth exploring together ${turning.length > 1 ? 'are' : 'is'} where the colour changes: ${turning.length > 1 ? 'ages ' : 'age '}${joinList(turning.map(String))}.` : '');
  const markers = [];
  if (reds.length) markers.push({ label: 'Most challenging (red)', value: cap(joinList(reds.map(span))) });
  if (longGreen) markers.push({ label: 'Longest green period', value: cap(span(longGreen)) });
  markers.push({ label: 'Now', value: cap(nowCol) + (since !== now ? ', since age ' + since.a : '') });
  return { markers, insight: parts.join(' '), meaning, now: cap(nowCol) + (since !== now ? ', since age ' + since.a : ''), turnTo: since !== pts[0] ? since.a : null, nowCol };
}

// ---------- compose a full report draft from raw EmoWave signals ----------
// Stress type comes from EmoWave's own description; the number alone is only a fallback.
function stressType(text, v) {
  if (/logical|intellect|problem solver|\bhow\b|\bwhy\b/i.test(text || '')) return 'Intellectual stress';
  if (/emotion/i.test(text || '')) return 'Emotional stress';
  if (/extreme/i.test(text || '')) return 'Extreme stress';
  if (/stable/i.test(text || '')) return 'Stable';
  return '';
}
function compose(raw, opts) {
  opts = opts || {};
  const fn = String(opts.fileName || '').replace(/\.pdf$/i, '');
  const fnRef = (fn.match(/\bEW[-_ ]?\d{3,6}\b/i) || [''])[0].toUpperCase().replace(/[_ ]/, '-');
  const fnName = fnRef ? clean(fn.split(new RegExp(fnRef.replace('-', '[-_ ]?'), 'i'))[0].replace(/[_-]+/g, ' ')) : '';
  const out = { meta: { name: raw.name || fnName, date: raw.date || '', source: 'EmoWave Full', ref: raw.ref || fnRef } };
  const lower = a => a.map(x => x.toLowerCase());

  // Mind: sensory attributes, brain activity, stress level
  const st = raw.stress && isFinite(raw.stress.value) ? raw.stress.value : null;
  const stText = raw.stress && raw.stress.text ? sentence(raw.stress.text) : '';
  const stType = stressType(stText, st);
  const bl = raw.brain && raw.brain.left, br = raw.brain && raw.brain.right;
  const lead = bl && br ? (br / bl > 1.5 ? 'right' : bl / br > 1.5 ? 'left' : 'balanced') : null;
  const ratio = bl && br ? Math.max(br / bl, bl / br) : 1, strong = lead !== 'balanced' && ratio >= 3;
  const BK = lead && lead !== 'balanced' && strong ? lead + '_strong' : lead;
  const sen = raw.sensory || {}, base = sen.base || {}, next = sen.next || {};
  const qual = x => [x.direction, x.energy].filter(Boolean).join(', ').toLowerCase();
  out.mind = {
    sensory: {
      base: { sense: base.sense || '', direction: base.direction || '', energy: base.energy || '', text: (SENSES[base.sense] || {}).base || '', direction_text: DIRECTION[base.direction] || '', energy_text: ENERGY[base.energy] || '' },
      next: { sense: next.sense || '', direction: next.direction || '', energy: next.energy || '', text: (SENSES[next.sense] || {}).next || '', direction_text: DIRECTION[next.direction] || '', energy_text: ENERGY[next.energy] || '' },
      text: base.sense && next.sense ? `When you receive information, the first sensory attribute you use is ${base.sense.toLowerCase()}${qual(base) ? ' (' + qual(base) + ')' : ''}. The next, which you use more of to process and analyse it, is ${next.sense.toLowerCase()}${qual(next) ? ' (' + qual(next) + ')' : ''}.` : '',
    },
    brain: bl || br ? { left: bl || 0, right: br || 0, label: BK ? BRAIN[BK].label : '', text: BK ? BRAIN[BK].text : '', line: BK ? BRAIN[BK].line : '' } : undefined,
    stress: st != null ? { value: st, type: stType, text: stText } : undefined,
  };
  if (st != null && !stType) raw.warnings.push('Stress type could not be read from the EmoWave text. Fill it in under 02 How your mind works.');

  // Emotional state: empowering, dis-empowering, frequent and core emotion, notes
  const emp = raw.empowering || [], dis = raw.disempowering || [];
  out.emotional = {
    thrive: emp.length ? { emotion: emp[0], also: emp.slice(1), text: `EmoWave reads ${joinList(lower(emp))} as your empowering ${emp.length > 1 ? 'emotions' : 'emotion'}: the states that give you energy.` } : {},
    drain: dis.length ? { emotion: dis[0], also: dis.slice(1), text: `EmoWave reads ${joinList(lower(dis))} as your dis-empowering ${dis.length > 1 ? 'emotions' : 'emotion'}: the states that take energy from you.` } : {},
    visible: raw.frequent ? { emotion: emoFrom(raw.frequent.short + ' ' + raw.frequent.text), text: [sentence(raw.frequent.short), raw.frequent.text ? sentence(raw.frequent.text) : ''].filter(Boolean).join(' ') } : {},
    deep: raw.core ? { emotion: emoFrom(raw.core.short + ' ' + raw.core.text), text: [sentence(raw.core.short), raw.core.text ? sentence(raw.core.text) : ''].filter(Boolean).join(' ') } : {},
    tones: (raw.notes || []).filter(n => n.note || n.reaction).map(n => ({ note: n.note, text: sentence(n.reaction) })),
  };

  // Present character, real intention, constructive attributes, leadership dynamics
  const pc = raw.present || {}, ri = raw.intention || {};
  out.social = {
    archetype: pc.name ? { name: title(pc.name), sub: clean(pc.traits), text: sentence(pc.summary) } : undefined,
    motivator: ri.name ? { name: title(ri.name), sub: clean(ri.traits), text: sentence(ri.summary) } : undefined,
    perception: (raw.constructive || []).filter(Boolean).map(t => ({ t: sentence(t).replace(/\.$/, ''), d: '' })),
    perception_summary: (raw.constructive || []).length ? 'You are consciously aware of these attributes: the actions you take from them empower you to create possibilities. They are the areas where you feel positive, with high energy.' : '',
    leadership: (raw.leadership || []).map(x => { const lv = levelOf(x.level); return { t: x.t, sub: x.sub, level: lv, d: (LEAD[x.t] || {})[lv] || '' }; }),
  };
  const hi = out.social.leadership.filter(x => x.level === 'High').map(x => x.t.toLowerCase()), lo = out.social.leadership.filter(x => x.level === 'Low').map(x => x.t.toLowerCase());
  if (hi.length || lo.length) out.social.leadership_summary = [hi.length ? `High: ${joinList(hi)}.` : '', lo.length ? `Low: ${joinList(lo)}.` : ''].filter(Boolean).join(' ');

  // Restrictive attributes (short name for the map; the full EmoWave wording is the reading)
  out.negativity = {
    core: {},
    patterns: (raw.restrictive || []).filter(Boolean).map(t => {
      const m = RESTRICT.find(r => r[0].test(t));
      return { name: m ? m[1] : cap(clean(t).split(/\s+/).slice(0, 4).join(' ')).replace(/[.,?]$/, ''), text: sentence(scrub(t).replace(/\?$/, '.')) };
    }),
  };

  // EmoWave sentences whose last words fall off the PDF's text layer at a page break.
  const ENDINGS = [[/place authority$/i, ' outside self']];
  // Potential mental and physical wellness challenges
  out.body = {
    patterns: (raw.wellness || []).map(w => {
      let t = cap(scrub(w.title).replace(/\?$/, ''));
      if (/^reading problems?$/i.test(t)) t = 'Reading and concentration';
      let raw0 = clean(w.description); ENDINGS.forEach(([re, end]) => { if (re.test(raw0)) raw0 += end; });
      const d = sentence(scrub(raw0));
      if (raw0 && !/[.?!]$/.test(raw0) && !ENDINGS.some(([re]) => re.test(clean(w.description)))) raw.warnings.push(`Wellness ${w.n} (${t}) looks cut off at a page break. Check the wording against the PDF.`);
      return { title: t, meaning: d };
    }),
    organs: (raw.organs || []).filter(Boolean),
  };

  // Life journey (ticks entered by hand from page 5)
  const age = opts.age || '';
  out.journey = { age, ages: journeyAges(age), levels: opts.levels || [] };
  const jr = journeyRead(out.journey.ages, out.journey.levels);
  if (jr) Object.assign(out.journey, { markers: jr.markers, insight: jr.insight, meaning: jr.meaning });

  // Overview: only what EmoWave says, with the section it comes from
  const signals = [];
  if (base.sense) signals.push({ label: 'Processing', value: `${base.sense}${next.sense ? ' → ' + next.sense : ''}${BK ? ', ' + BRAIN[BK].label.toLowerCase() : ''}`, strength: 'Sensory attributes · Brain activities' });
  if (st != null) signals.push({ label: 'Stress', value: `${stType || 'Stress level'} · ${st.toFixed(2)}`, strength: 'Stress level' });
  if (pc.name && ri.name) signals.push({ label: 'Character and intention', value: `${title(pc.name)} → ${title(ri.name)}`, strength: 'Present character · Real intention' });
  if (jr) signals.push({ label: 'Life journey now', value: jr.now, strength: 'Past experiences' });
  out.synthesis = {
    headline: 'Six chapters. One operating map.',
    signals,
    read: [
      pc.name && ri.name ? `Your present character is the ${title(pc.name)} (${traitList(pc.traits)}), and your real intention is the ${title(ri.name)} (${traitList(ri.traits)}).` : '',
      base.sense && next.sense ? `You take information in through ${base.sense.toLowerCase()} and process it through ${next.sense.toLowerCase()}` + (bl && br ? `, with brain activity of ${br} on the right and ${bl} on the left.` : '.') : '',
      stType === 'Intellectual stress' ? 'Your stress is intellectual: you search for answers and ask "how" and "why", and at times you know the answer and still argue against it.' : stType ? `Your stress reads as ${stType.toLowerCase()}.` : '',
    ].filter(Boolean).join(' '),
    changes: 'We do not start from "what is wrong". We start from the biggest gap between how you feel inside, how you act outside, and the outcome you want. The report narrows where to look first.',
    questions: [
      /\bhow\b/i.test(stText) ? 'Where are you saying "I know, but how?" right now?' : '',
      out.negativity.patterns.length ? `Which of your ${out.negativity.patterns.length} restrictive attributes do you recognise most right now?` : '',
      jr && jr.turnTo && jr.nowCol !== 'green' ? `What changed for you around age ${jr.turnTo}, when the ticks moved into ${jr.nowCol}?` : '',
      lo.length ? `${cap(joinList(lo))} ${lo.length > 1 ? 'read' : 'reads'} low. Where do you feel that most in your week?` : '',
    ].filter(Boolean),
  };
  out.notes = { tests: ['six_factor', 'dark_triad'] };
  adapt(out, { lead, strong, ratio, jr });
  return out;
}

// Phrases that read as clinical or as a verdict, for the founder to review before publishing.
function lint(data) {
  const hits = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const m = v.match(/\b(autism|austism|autistic|adhd|dyslexi\w*|bipolar|depression|disorder|diagnos\w*|allerg\w*|disease|cancer|tumou?r|syndrome|his\/her|he\/she|you are broken|you will)\b/gi);
      if (m) hits.push({ path, words: [...new Set(m.map(x => x.toLowerCase()))], text: v });
    } else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, path ? path + '.' + k : k));
  };
  walk(data, '');
  return hits;
}

const api = { BRAIN_WAYS, readPdf, parse, extract, compose, lint, journeyAges, journeyRead, zone, STRESS_BANDS, LIB: { SENSES, BRAIN, LEAD, RESTRICT, EMO: Object.fromEntries(EMO_WORDS.map(([, n]) => [n, 1])) } };
root.MaktoubEmowave = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
