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
const STRESS = [
  { max: 5.99, band: 'Logical', type: 'Logical load', phrase: 'mostly mental: problems to solve rather than feelings to carry', text: 'Your stress reads as mostly mental: problems to solve rather than feelings to carry. It tends to clear once you have an answer, and builds when you keep asking "how" without allowing yourself to act on what you already know.' },
  { max: 11.99, band: 'Stable', type: 'Stable', phrase: 'steady and being processed', text: 'Your system reads as steady. Pressure is present but being metabolised. This is the baseline worth protecting as the programme asks more of you.' },
  { max: 19.99, band: 'Accumulated', type: 'Accumulated stress', phrase: 'accumulated: building up rather than clearing', text: 'Your stress appears to be building up rather than clearing. It is not one event but small unresolved loads stacking over time, often emotional ones dressed up as practical problems. It usually shows up as tiredness that sleep does not fully fix.' },
  { max: 54, band: 'Emotional', type: 'Emotional stress', phrase: 'emotional rather than task-based', text: 'Your stress appears to be emotional rather than task-based. You may be carrying social tension, atmosphere and other people\'s signals that have not had space to be processed.' },
  { max: Infinity, band: 'Extreme', type: 'High load', phrase: 'heavy, a signal to reduce demands first', text: 'Your system appears to be carrying a heavy load. This is a signal to reduce demands and add support before adding anything new.' },
];
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
};

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

const EMO = {
  Ease: { thrive: 'You are at your best when things feel unforced. Ease is your signal that you are in the right place, doing the right thing at the right pace.', drain: 'Too much ease can become avoidance: comfort chosen over the stretch you need.' },
  Coolness: { thrive: 'Composure is a resource for you. When you stay cool, you see clearly and others steady around you.', drain: 'Coolness can turn into distance, staying unaffected so you do not have to feel.' },
  Calm: { thrive: 'Calm is where your best judgement lives.', drain: 'Calm can become a mask that hides what is actually happening underneath.' },
  Joy: { thrive: 'Joy is your fuel. When it is present your energy multiplies and others feel it.', drain: 'Chasing good feeling can pull you away from what needs facing.' },
  Passion: { thrive: 'When passion is present you are most in sync with the best version of yourself.', drain: 'Passion without boundaries burns through your reserves.' },
  Trust: { thrive: 'You thrive where you can trust and be trusted.', drain: 'Misplaced trust costs you more than most.' },
  Love: { thrive: 'Connection is your strongest source of energy.', drain: 'Over-giving in relationships may leave little for you.' },
  Confidence: { thrive: 'Confidence lets you act before everything is certain.', drain: 'Over-confidence can skip the listening that would have helped.' },
  Optimism: { thrive: 'Hope keeps you moving through hard stretches.', drain: 'Optimism can delay decisions that need making now.' },
  Resolve: { thrive: 'Resolve carries you through; once committed, you keep going.', drain: 'Resolve can become rigidity, pushing on when it is time to change course.' },
  Anger: { thrive: 'Channelled, anger gives you the energy to set boundaries and change what is wrong.', drain: 'Anger is the emotion most likely to cost you energy. It often points to a boundary crossed or a need not met.' },
  Surprise: { thrive: 'Novelty wakes you up; you respond well to the unexpected.', drain: 'The unexpected unsettles you more than it should. Not knowing what is coming keeps your system on alert.' },
  Fear: { thrive: 'Fear sharpens your attention when stakes are real.', drain: 'Fear drains you most when it is anticipating rather than responding, protecting you from things that have not happened.' },
  Sadness: { thrive: 'Sadness lets you feel what matters and let go.', drain: 'Unprocessed sadness quietly lowers your energy and colours how you read the day.' },
  Anxiety: { thrive: 'Your sensitivity to risk keeps you prepared.', drain: 'Worry runs in the background and uses energy you need elsewhere.' },
  Frustration: { thrive: 'Frustration shows you where something needs to change.', drain: 'Frustration builds when effort and results stop matching.' },
  Disgust: { thrive: 'Your standards protect you from what is not right for you.', drain: 'Rejection of what you dislike can become rejection of people.' },
  Guilt: { thrive: 'Your conscience keeps you honest.', drain: 'Guilt keeps you paying for things that are already finished.' },
  Shame: { thrive: 'You care deeply about how you show up.', drain: 'Shame makes you hide the parts that most need support.' },
};
const EMO_WORDS = [[/sad|tear|grie|melanchol/i, 'Sadness'], [/anger|angry|irrit|rage/i, 'Anger'], [/fear|afraid|scared/i, 'Fear'], [/anxi|worr|nervous/i, 'Anxiety'], [/strong.?will|determin|challenge|resol/i, 'Resolve'], [/joy|happy|cheer/i, 'Joy'], [/calm|peace/i, 'Calm'], [/love|affection/i, 'Love'], [/confiden/i, 'Confidence'], [/frustrat/i, 'Frustration'], [/guilt/i, 'Guilt'], [/shame/i, 'Shame'], [/passion/i, 'Passion'], [/trust/i, 'Trust']];
const emoFrom = t => { for (const [re, n] of EMO_WORDS) if (re.test(t || '')) return n; return ''; };

const RESTRICT = [
  [/self.?focus/i, 'Self-focused', 'Your attention is turned inward right now.', 'Notice when looking after yourself becomes not seeing the people around you.'],
  [/role.*relationship|relationship.*role/i, 'Unsure of my role', 'You may not be sure where you stand with the people closest to you.', 'Notice where you wait to be told your place instead of choosing it.'],
  [/physical body|body/i, 'Body-watchful', 'You keep a close eye on how your body is changing.', 'Notice whether that attention is care or worry.'],
  [/too direct|direct/i, 'Too direct', 'Your honesty can land harder than you mean it to.', 'Notice the moment just before you say it, and whether the other person can hear it.'],
  [/childlike|child/i, 'Inner child', 'In the background, a younger part of you still reacts first.', 'Notice when a reaction feels older than the situation in front of you.'],
  [/perfect/i, 'Perfectionist', 'Mistakes feel dangerous, so polishing replaces progress.', 'Notice where waiting for the perfect version is a form of hiding.'],
  [/critic|hard on/i, 'Harsh self-critic', 'Your inner voice uses pressure to motivate.', 'Notice the tone of your inner voice when things do not go to plan.'],
  [/argu|combat|defens/i, 'Combative', 'Protection can look like pushing back.', 'Notice the tension in your body when you feel the urge to argue.'],
  [/overthink|analys/i, 'Overthinker', 'Analysis can become a way of not deciding.', 'Notice how much energy goes on "what if" compared with trying something.'],
  [/guard|distance|withdraw/i, 'Guarded', 'Distance feels safer than being known.', 'Notice the moment you decide to hold back a true thought or feeling.'],
  [/control/i, 'Need for control', 'Certainty feels safer than trust.', 'Notice what you are protecting when you need to control the outcome.'],
  [/prove/i, 'Proving', 'Worth feels like something to earn.', 'Notice who you are still trying to convince.'],
];
// Speculative clinical wording is not passed through to the client.
const scrub = s => {
  s = String(s || '').replace(/[.,]?\s*(maybe|possibly|perhaps)\s+due to\s+[^.?!]*[.?!]?/gi, '.');
  s = s.split(/(?<=[.?!])\s+/).map(sent => sent.split(/,\s*/).filter(part => !CLINICAL_WORD.test(part)).join(', ')).filter(x => x && !/^[.?!,\s]*$/.test(x)).join(' ');
  return clean(s.replace(/,\s*([.?!])/g, '$1')).replace(/\.\.$/, '.');
};
const CLINICAL_WORD = /\b(autism|austism|autistic|adhd|dyslexi\w*|bipolar|depression|disorder|diagnos\w*|allerg\w*|disease|cancer|tumou?r|syndrome)\b/i;

const BODY = [
  { re: /nervous/i, title: 'Overstimulated nervous system', interpretation: 'Your system may be taking in more than it can settle.', meaning: 'The nervous system reads and filters everything around you and sets the body\'s sense of safety. When it is overstimulated it struggles to hear you over everyone else.', asking: 'More protected space, fewer demands, and permission to stop proving.', closing: 'A radio tuned to every station at once.' },
  { re: /lymph/i, title: 'Lymphatic load', interpretation: 'Your body\'s clearing system may be working overtime.', meaning: 'The lymphatic system clears what the body no longer needs. When it is loaded, it often mirrors a mind holding on to one thing too tightly to see other options.', asking: 'Movement, water and release: letting something go so there is room for what is next.', closing: 'A river that slows when too much is carried in it.' },
  { re: /endocrin|hormon/i, title: 'Endocrine stress', interpretation: 'Your inner authority may be handed outward, keeping your body in performance mode.', meaning: 'The endocrine system signals safety or threat through hormones. Constant performance keeps that signal raised, which makes rest harder to reach.', asking: 'Your own rhythm back: real activity followed by real stillness, without guilt for the stillness.', closing: 'A body waiting for permission that only you can give.' },
  { re: /digest|assimil|colon|stomach|gut/i, title: 'Digestive / assimilation stress', interpretation: 'Stress may be making it harder to break down and absorb both food and experience.', meaning: 'Digestion is how the body takes in the world. When life is hard to digest, the body tends to tighten too.', asking: 'Simpler inputs, slower transitions, and moments where nothing is required of you.', closing: 'Full, yet not nourished.' },
  { re: /read|concentrat|focus|eye|visual/i, title: 'Focus and reading fatigue', interpretation: 'Concentration may tire faster than usual, especially with sustained reading or screens.', meaning: 'Attention is a resource that drains under stress. If this matches your experience, an eye test is a simple first check.', asking: 'Shorter blocks of focus, breaks for the eyes, and less input at the end of the day.', closing: 'Attention is spent like energy: it needs refilling.' },
  { re: /lung|breath|respir/i, title: 'Breath and respiratory load', interpretation: 'Your breathing may be holding tension.', meaning: 'Breath is the one stress response you can steer directly. Shallow breathing keeps the body on alert.', asking: 'Slow, full breaths, especially at transitions in the day.', closing: 'Room to breathe, literally.' },
  { re: /heart|cardio/i, title: 'Heart load', interpretation: 'Your heart may be carrying emotional as well as physical work.', meaning: 'Pressure in relationships often registers here first.', asking: 'Connection without having to perform for it.', closing: '' },
  { re: /liver|gall/i, title: 'Liver and gallbladder load', interpretation: 'Frustration or unexpressed decisions may be held here.', meaning: 'These organs process and release. In the body\'s language they are linked to decision and to anger left unsaid.', asking: 'A decision made, or something said that has waited too long.', closing: '' },
  { re: /kidney|adrenal/i, title: 'Kidney and adrenal load', interpretation: 'Your reserves may be running low.', meaning: 'This is where long-term stress draws down your reserves.', asking: 'Rest that is real, not earned.', closing: '' },
  { re: /immun/i, title: 'Immune load', interpretation: 'Your defences may be busy.', meaning: 'A stretched immune system often follows a stretched life.', asking: 'Fewer battles, more recovery.', closing: '' },
];

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
  const pts = ages.map((a, i) => ({ a, l: +levels[i] })).filter(p => p.l >= 1 && p.l <= 7);
  if (pts.length < 4) return null;
  const span = (arr) => arr[0].a === arr.at(-1).a ? 'Age ' + arr[0].a : 'Age ' + arr[0].a + '–' + arr.at(-1).a;
  const runs = test => { const out = []; let cur = []; pts.forEach(p => { if (test(p.l)) cur.push(p); else { if (cur.length) out.push(cur); cur = []; } }); if (cur.length) out.push(cur); return out; };
  const maxL = Math.max(...pts.map(p => p.l)), minL = Math.min(...pts.map(p => p.l));
  const hard = runs(l => l >= Math.max(maxL - 1, 4)).sort((a, b) => Math.max(...b.map(p => p.l)) - Math.max(...a.map(p => p.l)) || b.length - a.length)[0];
  const steady = runs(l => l <= Math.min(minL + 1, 3)).sort((a, b) => b.length - a.length)[0];
  const last = pts.slice(-3), d = last.at(-1).l - last[0].l, now = pts.at(-1);
  const trend = d >= 2 ? 'rising' : d <= -2 ? 'easing' : 'steady';
  const nowLabel = { constructive: 'Gaining energy', mixed: 'Mixed', restrictive: 'Under strain' }[zone(now.l)];
  const markers = [];
  if (hard && maxL >= 4) markers.push({ label: 'Hardest period', value: span(hard) });
  if (steady && minL <= 3) markers.push({ label: 'Steadiest period', value: span(steady) });
  markers.push({ label: 'Now', value: nowLabel + (trend === 'rising' ? ', load rising' : trend === 'easing' ? ', load easing' : '') });
  const parts = [];
  if (hard && maxL >= 6) parts.push(`The strongest strain registers ${hard[0].a < pts[0].a + 6 ? 'early' : ''} at ${span(hard).toLowerCase()}`.replace('  ', ' '));
  else if (hard && maxL >= 4) parts.push(`The most demanding stretch registers at ${span(hard).toLowerCase()}`);
  if (steady && minL <= 3) parts.push(`followed by a long constructive stretch at ${span(steady).toLowerCase()}`);
  let insight = parts.length ? cap(parts.join(', ')) + '.' : '';
  insight += trend === 'rising' ? ' In recent years the load has been building again, and you are now in the ' + (zone(now.l) === 'restrictive' ? 'red' : 'middle') + ' zone.' : trend === 'easing' ? ' In recent years the load has been easing.' : ' Recently the pattern has held steady.';
  const meaning = trend === 'rising'
    ? 'The rise is not a judgement on where you are. It shows that something in the present is costing more energy than it gives back, and that you have been here before and found your way to steadier ground. The steadier stretch is evidence of what you can return to.'
    : trend === 'easing'
      ? 'The direction is toward steadier ground. The work is to understand what changed so you can keep choosing it on purpose.'
      : 'The graph does not say what happened, only that each period registered. Use the turning points as prompts: what was happening then, and what did it teach your system to expect?';
  return { markers, insight: insight.trim(), meaning, trend, now: nowLabel };
}

// ---------- compose a full report draft from raw EmoWave signals ----------
function compose(raw, opts) {
  opts = opts || {};
  const fn = String(opts.fileName || '').replace(/\.pdf$/i, '');
  const fnRef = (fn.match(/\bEW[-_ ]?\d{3,6}\b/i) || [''])[0].toUpperCase().replace(/[_ ]/, '-');
  const fnName = fnRef ? clean(fn.split(new RegExp(fnRef.replace('-', '[-_ ]?'), 'i'))[0].replace(/[_-]+/g, ' ')) : '';
  const out = { meta: { name: raw.name || fnName, date: raw.date || '', source: 'EmoWave Full', ref: raw.ref || fnRef } };

  // Mind
  const st = raw.stress && isFinite(raw.stress.value) ? raw.stress.value : null;
  const sb = st == null ? null : STRESS.find(b => st <= b.max);
  const bl = raw.brain && raw.brain.left, br = raw.brain && raw.brain.right;
  const lead = bl && br ? (br / bl > 1.5 ? 'right' : bl / br > 1.5 ? 'left' : 'balanced') : null;
  const sen = raw.sensory || {};
  const base = sen.base || {}, next = sen.next || {};
  out.mind = {
    sensory: {
      base: { sense: base.sense || '', direction: base.direction || '', energy: base.energy || '', text: (SENSES[base.sense] || {}).base || '', direction_text: DIRECTION[base.direction] || '', energy_text: ENERGY[base.energy] || '' },
      next: { sense: next.sense || '', direction: next.direction || '', energy: next.energy || '', text: (SENSES[next.sense] || {}).next || '', direction_text: DIRECTION[next.direction] || '', energy_text: ENERGY[next.energy] || '' },
      text: base.sense && next.sense ? `You take information in through ${base.sense.toLowerCase()} first${base.direction ? ', facing ' + base.direction.toLowerCase() : ''}, then process it through ${next.sense.toLowerCase()}${next.direction ? ', turned ' + next.direction.toLowerCase() : ''}. ${base.energy && next.energy && base.energy !== next.energy ? 'You meet the world as an ' + base.energy.toLowerCase() + ' and digest it as an ' + next.energy.toLowerCase() + ': people may see the outgoing first half and miss how much quiet you need for the second.' : ''}`.trim() : '',
    },
    brain: bl || br ? { left: bl || 0, right: br || 0, label: lead ? BRAIN[lead].label : '', text: lead ? BRAIN[lead].text : '', line: lead ? BRAIN[lead].line : '' } : undefined,
    stress: st != null ? { value: st, band: sb.band, type: sb.type, text: sb.text, source: raw.stress.text ? sentence(raw.stress.text) : '' } : undefined,
  };

  // Emotional mastery
  const emp = raw.empowering || [], dis = raw.disempowering || [];
  const emo = (slot, name, extra) => ({ emotion: name || '', text: name && EMO[name] ? EMO[name][slot === 'drain' ? 'drain' : 'thrive'] : '', also: extra || [] });
  out.emotional = {
    thrive: emo('thrive', emp[0], emp.slice(1)),
    drain: emo('drain', dis[0], dis.slice(1)),
    visible: raw.frequent ? { emotion: emoFrom(raw.frequent.short + ' ' + raw.frequent.text), text: 'This is the emotion that keeps showing up, and the one people around you are most likely to notice. ' + sentence(raw.frequent.short), deep: raw.frequent.text ? sentence(raw.frequent.text) : '' } : {},
    deep: raw.core ? { emotion: emoFrom(raw.core.short + ' ' + raw.core.text), text: 'This is the stronger emotion underneath the one that shows. ' + sentence(raw.core.short), deep: raw.core.text ? sentence(raw.core.text) : '' } : {},
    tones: (raw.notes || []).filter(n => n.note || n.reaction).map(n => ({ note: n.note, text: sentence(n.reaction) })),
  };
  if (out.emotional.thrive.emotion && out.emotional.thrive.also.length) out.emotional.thrive.deep = `Alongside ${out.emotional.thrive.emotion.toLowerCase()}, ${joinList(out.emotional.thrive.also.map(x => x.toLowerCase()))} also register${out.emotional.thrive.also.length > 1 ? '' : 's'} as empowering for you. ` + ((EMO[out.emotional.thrive.also[0]] || {}).thrive || '');
  if (out.emotional.drain.emotion && out.emotional.drain.also.length) out.emotional.drain.deep = `${cap(joinList(out.emotional.drain.also.map(x => x.toLowerCase())))} also register${out.emotional.drain.also.length > 1 ? '' : 's'} as draining. ` + ((EMO[out.emotional.drain.also[0]] || {}).drain || '');

  // Social mirror
  const pc = raw.present || {}, ri = raw.intention || {};
  out.social = {
    archetype: pc.name ? { name: title(pc.name), sub: clean(pc.traits), text: sentence(pc.summary) } : undefined,
    motivator: ri.name ? { name: title(ri.name), sub: clean(ri.traits), text: sentence(ri.summary), force: pc.name ? `Outwardly you lead as the ${title(pc.name)}; underneath, what you are really reaching for is the ${title(ri.name)}'s ${traitList(ri.traits) || 'intention'}.` : '' } : undefined,
    perception: (raw.constructive || []).filter(Boolean).map(t => ({ t: sentence(t).replace(/\.$/, ''), d: '' })),
    perception_summary: (raw.notes || []).length ? 'Others may first meet the qualities below. They are the strengths you are already aware of and can draw on.' : '',
    leadership: (raw.leadership || []).map(x => { const lv = levelOf(x.level); return { t: x.t, sub: x.sub, level: lv, d: (LEAD[x.t] || {})[lv] || '' }; }),
  };
  const hi = out.social.leadership.filter(x => x.level === 'High').map(x => x.t.toLowerCase()), lo = out.social.leadership.filter(x => x.level === 'Low').map(x => x.t.toLowerCase());
  if (hi.length || lo.length) out.social.leadership_summary = (hi.length ? `Strong in ${joinList(hi)}` : 'A developing profile') + (lo.length ? `, with more development needed in ${joinList(lo)}.` : '.');

  // Negativity
  out.negativity = {
    core: {},
    patterns: (raw.restrictive || []).filter(Boolean).map(t => {
      const m = RESTRICT.find(r => r[0].test(t));
      return { name: m ? m[1] : cap(clean(t).split(/\s+/).slice(0, 3).join(' ')).replace(/[.,?]$/, ''), summary: m ? m[2] : '', text: sentence(scrub(t).replace(/\?$/, '.')), notice: m ? m[3] : '' };
    }),
  };

  // Mind and body
  out.body = {
    patterns: (raw.wellness || []).map(w => {
      const m = BODY.find(b => b.re.test(w.title)) || BODY.find(b => b.re.test(w.description)) || {};
      return { title: m.title || cap(scrub(w.title).replace(/\?$/, '')), interpretation: m.interpretation || '', meaning: sentence(scrub(w.description)), asking: m.asking || '', closing: m.closing || '' };
    }),
    organs: (raw.organs || []).filter(Boolean),
  };

  // Journey (ticks entered by hand)
  const age = opts.age || '';
  out.journey = { age, ages: journeyAges(age), levels: opts.levels || [] };
  const jr = journeyRead(out.journey.ages, out.journey.levels);
  if (jr) Object.assign(out.journey, { markers: jr.markers, insight: jr.insight, meaning: jr.meaning });

  // Overview
  const signals = [];
  if (base.sense) signals.push({ label: 'Dominant processing', value: `${base.sense}-led${lead && lead !== 'balanced' ? ', ' + lead + '-brain' : ''}`, strength: 'High signal' });
  if (sb) signals.push({ label: 'Stress signature', value: `${sb.type} · ${st.toFixed(2)}`, strength: st >= 12 ? 'High signal' : 'Moderate signal' });
  if (pc.name && ri.name) signals.push({ label: 'Public / private delta', value: `${title(pc.name)} outside, ${title(ri.name)} inside`, strength: 'Moderate signal' });
  if (jr) signals.push({ label: 'Current trajectory', value: jr.now + (jr.trend !== 'steady' ? ', ' + (jr.trend === 'rising' ? 'load rising' : 'load easing') : ''), strength: 'Cross-chapter signal' });
  const lowest = out.social.leadership.find(x => x.level === 'Low'), highest = out.social.leadership.find(x => x.level === 'High');
  const firstPattern = out.negativity.patterns[0];
  out.synthesis = {
    headline: 'Six chapters. One operating map.',
    signals,
    read: [
      pc.name && ri.name ? `Outwardly you lead as the ${title(pc.name)}${pc.traits ? ' (' + clean(pc.traits).toLowerCase() + ')' : ''}, while what you are really reaching for is the ${title(ri.name)}'s ${traitList(ri.traits)}.` : '',
      base.sense && lead ? `You take the world in through ${base.sense.toLowerCase()} and process with a ${lead === 'balanced' ? 'balanced' : lead + '-brain'} bias, so you often know before you can explain.` : '',
      sb ? `Your stress reads as ${sb.phrase}.` : '',
    ].filter(Boolean).join(' '),
    changes: 'We do not start from "what is wrong". We start from the biggest gap between how you feel inside, how you act outside, and the outcome you want. The report narrows where to look first.',
    questions: [
      firstPattern ? `Where is "${firstPattern.name.toLowerCase()}" costing you most right now?` : '',
      lowest && highest ? `What would ${lowest.t.toLowerCase()} look like if it were as strong as your ${highest.t.toLowerCase()}?` : '',
      jr && jr.trend === 'rising' ? 'What has been adding load in the last few years, and what did you do differently in your steadiest period?' : 'What do you already know that you have not yet acted on?',
    ].filter(Boolean),
  };
  out.notes = {};
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

const api = { readPdf, parse, extract, compose, lint, journeyAges, journeyRead, zone, STRESS_BANDS, LIB: { STRESS, SENSES, BRAIN, LEAD, EMO, RESTRICT, BODY } };
root.MaktoubEmowave = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
