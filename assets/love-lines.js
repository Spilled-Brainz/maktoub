/* Maktoub — a different line about love on every visit.
   Any element with [data-love-line] gets one. Avoids repeating the last line shown. */
(function () {
  var LINES = [
    "Most people marry what they think they want. Love is learning what you need.",
    "Chemistry is a question. Character is the answer.",
    "You don’t find the right person. You become someone who can recognise them.",
    "The heart isn’t blind. It keeps looking for the wound it already knows.",
    "Attraction remembers your past. Love chooses your future.",
    "Real intimacy begins where performance ends.",
    "We are drawn to the familiar and healed by the unfamiliar.",
    "Love is not something you fall into. It is somewhere you build together.",
    "What feels like home may only feel like childhood.",
    "Desire asks what you can give. Devotion asks who you are becoming.",
    "Peace is not the absence of chemistry. It is chemistry that doesn’t cost you yourself.",
    "Before you are chosen, be known.",
    "Two whole people don’t complete each other. They enlarge each other.",
    "Being seen is rarer than being wanted.",
    "Nothing meant for you will ask you to abandon yourself.",
    "Love arrives quietly to those who have stopped auditioning."
  ];
  var KEY = "maktoub_love_line";
  var last = -1;
  try { last = Number(localStorage.getItem(KEY)); } catch (e) {}
  var i;
  do { i = Math.floor(Math.random() * LINES.length); } while (LINES.length > 1 && i === last);
  try { localStorage.setItem(KEY, String(i)); } catch (e) {}
  function fill() {
    var els = document.querySelectorAll("[data-love-line]");
    for (var n = 0; n < els.length; n++) els[n].textContent = LINES[i];
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill);
  else fill();
})();
