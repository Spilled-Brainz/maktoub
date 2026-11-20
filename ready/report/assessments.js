/* Maktoub · assessments taken inside the client report.
   Item wording, order, response scales and keys exactly as published. The edge function maktoub-programme
   holds the same keys (generated from this file) and does the scoring; clients never see their scores.

   six_factor: Mini-IPIP6 (Sibley, Luyten, Purnomo et al., 2011, New Zealand Journal of Psychology 40(3), 142–159,
     Appendix B; key confirmed at ipip.ori.org/MiniIPIP6Key.htm). 20 items are IPIP items (public domain, any use).
     Items 6, 12, 18 and 24 (Honesty-Humility) are adapted from Campbell et al. (2004) and the HEXACO-PI-R;
     their commercial status is not confirmed.
   dark_triad: Short Dark Tetrad, SD4 (Paulhus, Buckels, Trapnell & Jones, European Journal of Psychological
     Assessment, doi 10.1027/1015-5759/a000602). Listed by the authors as public domain, "available without
     permission" (www2.psych.ubc.ca/~dpaulhus/Paulhus_measures/). Item text from their SD4.docx. Covers the
     Dark Triad plus sadism. The authors' feedback labels (Crafty, Special, Wild, Mean) are used for the client. */
(function (root) {
'use strict';
const I = s => 'I ' + s.charAt(0).toLowerCase() + s.slice(1); // Mini-IPIP6 items follow the stem "I..."
const A = {
  six_factor: {
    name: 'Six-factor personality', kicker: 'Personality · HEXACO model', minutes: 4,
    instrument: 'Mini-IPIP6 (Sibley et al., 2011)', version: 'mini-ipip6-2011',
    about: 'Twenty-four short statements about how you usually are. It maps the six broad dimensions of personality.',
    intro: 'Please choose the answer that best represents how accurately each statement describes you. Describe yourself as you generally are now, not as you wish to be. There are no right or wrong answers.',
    stem: 'How accurately does this describe you?', max: 7, anchors: ['Very inaccurate', 'Very accurate'],
    scales: { H: 'Honesty-Humility', N: 'Neuroticism', E: 'Extraversion', A: 'Agreeableness', C: 'Conscientiousness', O: 'Openness' },
    items: [
      ['Am the life of the party.', 'E'], ["Sympathize with others' feelings.", 'A'], ['Get chores done right away.', 'C'], ['Have frequent mood swings.', 'N'],
      ['Have a vivid imagination.', 'O'], ['Feel entitled to more of everything.', 'H', 1], ["Don't talk a lot.", 'E', 1], ["Am not interested in other people's problems.", 'A', 1],
      ['Have difficulty understanding abstract ideas.', 'O', 1], ['Like order.', 'C'], ['Make a mess of things.', 'C', 1], ['Deserve more things in life.', 'H', 1],
      ['Do not have a good imagination.', 'O', 1], ["Feel others' emotions.", 'A'], ['Am relaxed most of the time.', 'N', 1], ['Get upset easily.', 'N'],
      ['Seldom feel blue.', 'N', 1], ['Would like to be seen driving around in a very expensive car.', 'H', 1], ['Keep in the background.', 'E', 1], ['Am not really interested in others.', 'A', 1],
      ['Am not interested in abstract ideas.', 'O', 1], ['Often forget to put things back in their proper place.', 'C', 1], ['Talk to a lot of different people at parties.', 'E'], ['Would get a lot of pleasure from owning expensive luxury goods.', 'H', 1],
    ].map(([t, s, r]) => ({ t: I(t), s, r: !!r })),
  },
  dark_triad: {
    name: 'Four identities', kicker: 'Personality · Dark Triad and Tetrad', minutes: 5,
    instrument: 'Short Dark Tetrad, SD4 (Paulhus et al.)', version: 'sd4',
    about: 'Twenty-eight statements about how you deal with people and situations. Answer honestly; it is private.',
    intro: 'Rate your agreement with each statement. Go with your first reaction. There are no right or wrong answers, and your answers come only to us.',
    stem: 'How much do you agree?', max: 5, labels: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'],
    scales: { M: 'Crafty (Machiavellianism)', N: 'Special (Narcissism)', P: 'Wild (Psychopathy)', S: 'Mean (Sadism)' },
    items: [
      ["It's not wise to let people know your secrets.", 'M'], ['Whatever it takes, you must get the important people on your side.', 'M'], ['Avoid direct conflict with others because they may be useful in the future.', 'M'],
      ['Keep a low profile if you want to get your way.', 'M'], ['Manipulating the situation takes planning.', 'M'], ['Flattery is a good way to get people on your side.', 'M'], ['I love it when a tricky plan succeeds.', 'M'],
      ['People see me as a natural leader.', 'N'], ['I have a unique talent for persuading people.', 'N'], ['Group activities tend to be dull without me.', 'N'], ['I know that I am special because people keep telling me so.', 'N'],
      ['I have some exceptional qualities.', 'N'], ["I'm likely to become a future star in some area.", 'N'], ['I like to show off every now and then.', 'N'],
      ["People often say I'm out of control.", 'P'], ['I tend to fight against authorities and their rules.', 'P'], ["I've been in more fights than most people of my age and gender.", 'P'],
      ['I tend to dive in, then ask questions later.', 'P'], ["I've been in trouble with the law.", 'P'], ['I sometimes get into dangerous situations.', 'P'], ['People who mess with me always regret it.', 'P'],
      ['Watching a fist-fight excites me.', 'S'], ['I really enjoy violent films and video games.', 'S'], ["It's funny when idiots fall flat on their face.", 'S'], ['I enjoy watching violent sports.', 'S'],
      ['Some people deserve to suffer.', 'S'], ["Just for kicks, I've said mean things on social media.", 'S'], ['I know how to hurt someone with words alone.', 'S'],
    ].map(([t, s, r]) => ({ t, s, r: !!r })),
  },
};
// Plain explanations shown with the client's results: what each trait describes, and what the higher and lower
// ends tend to look like. Tendencies, not verdicts; scores are not compared with any population norm.
A.six_factor.traits = {
  H: { about: 'Sincerity, fairness and modesty about status and possessions.', high: 'Status, luxury and special treatment matter little to you, and fairness matters a lot.', low: 'Recognition, status and material rewards matter to you, and you may feel you deserve more.' },
  N: { about: 'How strongly worry, upset and changes of mood come and go.', high: 'Your feelings run strong and can shift quickly; upset may come on easily.', low: 'You tend to stay calm and even, and upset passes quickly.' },
  E: { about: 'How much energy you draw from people and social attention.', high: 'You enjoy company, conversation and being seen.', low: 'You prefer fewer people, quieter settings and staying in the background.' },
  A: { about: 'Warmth and concern for how other people feel.', high: 'You feel other people’s emotions and care about their problems.', low: 'You keep more distance from other people’s problems and stay with your own path.' },
  C: { about: 'Order, follow-through and getting things done.', high: 'You like order and tend to finish tasks promptly.', low: 'You are more spontaneous; order and routine take more effort.' },
  O: { about: 'Imagination and interest in ideas.', high: 'You have a vivid imagination and enjoy abstract ideas.', low: 'You prefer what is concrete and practical over abstract ideas.' },
};
A.dark_triad.traits = {
  M: { about: 'How strategically you handle people and information.', high: 'You think several moves ahead and are careful about what you reveal.', low: 'You tend to be open and direct rather than strategic with people.' },
  N: { about: 'Confidence in your own talents and enjoyment of being seen.', high: 'You trust your abilities and enjoy recognition and the spotlight.', low: 'You tend to be modest and do not seek the spotlight.' },
  P: { about: 'Impulsiveness, risk-taking and pushing back against rules.', high: 'You act fast, take risks and push back against authority.', low: 'You tend to think before acting and stay within the rules.' },
  S: { about: 'Enjoyment of rough humour, aggression or other people’s discomfort.', high: 'Rough humour or aggression holds some appeal for you.', low: 'You take little pleasure in other people’s discomfort.' },
};
// Same scoring as the server: mean per scale, reversed items flipped. Used only in previews, where nothing is saved.
A.score = (kind, answers) => { const T = A[kind], sums = {}; T.items.forEach((it, i) => { (sums[it.s] = sums[it.s] || []).push(it.r ? T.max + 1 - answers[i] : answers[i]); }); return Object.fromEntries(Object.keys(T.scales).map(k => [k, Math.round(sums[k].reduce((a, b) => a + b, 0) / sums[k].length * 100) / 100])); };
root.MaktoubAssessments = A;
if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
